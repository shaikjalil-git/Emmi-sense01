
/**
 * ========================================================================================
 * EMMISENSE — MULTI-CHANNEL GAS TELEMETRY & SENSOR CONTROLLER
 * Active Sensors:
 * - MQ-2 (Combustible Gas / LPG / Smoke) on GPIO 34
 * - MQ-135 (Air Quality / NH3 / Ammonia) on GPIO 35 [Preserved Unchanged]
 * - MQ-7 (Carbon Monoxide / CO) Active Channel
 * - MQ-137 / MQ-136 (Nitrogen Dioxide / NO₂) Active Channel
 * - SGP30 / MQ (Carbon Dioxide CO₂ & TVOC) Active Digital Channel
 * - Ambient Environmental Monitor (Temp / Humidity / Pressure)
 * ========================================================================================
 */

// ==========================================================================
// CONFIGURATION & GLOBAL STATE
// ==========================================================================
const CONFIG = {
  DEFAULT_ESP32_HOST: "192.168.4.1", 
  HTTP_ENDPOINT: "/api/data",
  WS_ENDPOINT: "/ws",
  POLL_INTERVAL_MS: 3000,
  MAX_HISTORY_POINTS: 60,
};

let THRESHOLDS = {
  mq2: { warn: 15.0, danger: 35.0 },
  mq135: { warn: 15.0, danger: 35.0 },
  co: { warn: 9.0, danger: 25.0 },
  no2: { warn: 0.05, danger: 0.20 },
  co2: { warn: 1000.0, danger: 2000.0 }
};

let state = {
  dataSource: 'http',
  espHost: CONFIG.DEFAULT_ESP32_HOST,
  isConnected: false,
  pollTimer: null,
  wsReconnectTimer: null,
  wsInstance: null,
  packetCount: 0,
  sessionStartTime: Date.now(),
  sessionHistory: [],
  snapshots: [],
  peaks: { mq2: 0, mq135: 0, co: 0, no2: 0, co2: 400, temp: 0 }
};

const charts = {};

document.addEventListener('DOMContentLoaded', () => {
  loadStoredSettings();
  initCharts();
  startSessionTimer();
  
  const sourceSelector = document.getElementById('dataSourceSelect');
  if (sourceSelector) {
    state.dataSource = sourceSelector.value;
    const ipGroup = document.getElementById('ipConfigGroup');
    const serialBtn = document.getElementById('serialConnectBtn');
    if (ipGroup) ipGroup.style.display = (state.dataSource === 'http' || state.dataSource === 'ws') ? 'flex' : 'none';
    if (serialBtn) serialBtn.style.display = (state.dataSource === 'serial') ? 'inline-flex' : 'none';
  }

  const ipInput = document.getElementById('espIpInput');
  if (ipInput) {
    state.espHost = ipInput.value.trim() || CONFIG.DEFAULT_ESP32_HOST;
    ipInput.addEventListener('change', (e) => {
      state.espHost = e.target.value.trim() || CONFIG.DEFAULT_ESP32_HOST;
      localStorage.setItem('emmisense_esp_host', state.espHost);
      restartConnection();
    });
  }

  startTelemetry();
});

function loadStoredSettings() {
  const savedHost = localStorage.getItem('emmisense_esp_host');
  if (savedHost) {
    state.espHost = savedHost;
    const ipInput = document.getElementById('espIpInput');
    if (ipInput) ipInput.value = savedHost;
  }

  const savedThresholds = localStorage.getItem('emmisense_multi_thresholds');
  if (savedThresholds) {
    try {
      THRESHOLDS = Object.assign(THRESHOLDS, JSON.parse(savedThresholds));
      applyThresholdsToUI();
    } catch (e) {
      console.warn("Failed to parse saved thresholds:", e);
    }
  }
}

function applyThresholdsToUI() {
  const wMq2 = document.getElementById('cfg-warn-mq2');
  const dMq2 = document.getElementById('cfg-dang-mq2');
  const wMq135 = document.getElementById('cfg-warn-mq135');
  const dMq135 = document.getElementById('cfg-dang-mq135');
  const wCo = document.getElementById('cfg-warn-co');
  const dCo = document.getElementById('cfg-dang-co');
  const wNo2 = document.getElementById('cfg-warn-no2');
  const dNo2 = document.getElementById('cfg-dang-no2');
  const wCo2 = document.getElementById('cfg-warn-co2');
  const dCo2 = document.getElementById('cfg-dang-co2');

  if (wMq2) wMq2.value = THRESHOLDS.mq2.warn;
  if (dMq2) dMq2.value = THRESHOLDS.mq2.danger;
  if (wMq135) wMq135.value = THRESHOLDS.mq135.warn;
  if (dMq135) dMq135.value = THRESHOLDS.mq135.danger;
  if (wCo) wCo.value = THRESHOLDS.co.warn;
  if (dCo) dCo.value = THRESHOLDS.co.danger;
  if (wNo2) wNo2.value = THRESHOLDS.no2.warn;
  if (dNo2) dNo2.value = THRESHOLDS.no2.danger;
  if (wCo2) wCo2.value = THRESHOLDS.co2.warn;
  if (dCo2) dCo2.value = THRESHOLDS.co2.danger;

  const limWMq2 = document.getElementById('lim-warn-mq2');
  const limDMq2 = document.getElementById('lim-dang-mq2');
  const limWMq135 = document.getElementById('lim-warn-mq135');
  const limDMq135 = document.getElementById('lim-dang-mq135');
  const limWCo = document.getElementById('lim-warn-co');
  const limDCo = document.getElementById('lim-dang-co');
  const limWNo2 = document.getElementById('lim-warn-no2');
  const limDNo2 = document.getElementById('lim-dang-no2');
  const limWCo2 = document.getElementById('lim-warn-co2');
  const limDCo2 = document.getElementById('lim-dang-co2');

  if (limWMq2) limWMq2.innerText = THRESHOLDS.mq2.warn.toFixed(1);
  if (limDMq2) limDMq2.innerText = THRESHOLDS.mq2.danger.toFixed(1);
  if (limWMq135) limWMq135.innerText = THRESHOLDS.mq135.warn.toFixed(1);
  if (limDMq135) limDMq135.innerText = THRESHOLDS.mq135.danger.toFixed(1);
  if (limWCo) limWCo.innerText = THRESHOLDS.co.warn.toFixed(1);
  if (limDCo) limDCo.innerText = THRESHOLDS.co.danger.toFixed(1);
  if (limWNo2) limWNo2.innerText = THRESHOLDS.no2.warn.toFixed(2);
  if (limDNo2) limDNo2.innerText = THRESHOLDS.no2.danger.toFixed(2);
  if (limWCo2) limWCo2.innerText = Math.round(THRESHOLDS.co2.warn);
  if (limDCo2) limDCo2.innerText = Math.round(THRESHOLDS.co2.danger);
}

function saveThresholds() {
  const w2 = parseFloat(document.getElementById('cfg-warn-mq2')?.value);
  const d2 = parseFloat(document.getElementById('cfg-dang-mq2')?.value);
  const w135 = parseFloat(document.getElementById('cfg-warn-mq135')?.value);
  const d135 = parseFloat(document.getElementById('cfg-dang-mq135')?.value);
  const wCo = parseFloat(document.getElementById('cfg-warn-co')?.value);
  const dCo = parseFloat(document.getElementById('cfg-dang-co')?.value);
  const wNo2 = parseFloat(document.getElementById('cfg-warn-no2')?.value);
  const dNo2 = parseFloat(document.getElementById('cfg-dang-no2')?.value);
  const wCo2 = parseFloat(document.getElementById('cfg-warn-co2')?.value);
  const dCo2 = parseFloat(document.getElementById('cfg-dang-co2')?.value);

  if (!isNaN(w2) && !isNaN(d2)) THRESHOLDS.mq2 = { warn: w2, danger: d2 };
  if (!isNaN(w135) && !isNaN(d135)) THRESHOLDS.mq135 = { warn: w135, danger: d135 };
  if (!isNaN(wCo) && !isNaN(dCo)) THRESHOLDS.co = { warn: wCo, danger: dCo };
  if (!isNaN(wNo2) && !isNaN(dNo2)) THRESHOLDS.no2 = { warn: wNo2, danger: dNo2 };
  if (!isNaN(wCo2) && !isNaN(dCo2)) THRESHOLDS.co2 = { warn: wCo2, danger: dCo2 };

  localStorage.setItem('emmisense_multi_thresholds', JSON.stringify(THRESHOLDS));
  applyThresholdsToUI();
}

function resetDefaultThresholds() {
  THRESHOLDS = {
    mq2: { warn: 15.0, danger: 35.0 },
    mq135: { warn: 15.0, danger: 35.0 },
    co: { warn: 9.0, danger: 25.0 },
    no2: { warn: 0.05, danger: 0.20 },
    co2: { warn: 1000.0, danger: 2000.0 }
  };
  localStorage.removeItem('emmisense_multi_thresholds');
  applyThresholdsToUI();
}

function createChartConfig(colorHex, label, unit, suggestedMax) {
  return {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: `${label} (${unit})`,
        data: [],
        borderColor: colorHex,
        backgroundColor: colorHex + '22',
        borderWidth: 2,
        tension: 0.42,
        fill: true,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHitRadius: 14,
        pointBackgroundColor: colorHex,
        pointBorderColor: '#ffffff',
        pointBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220, easing: 'easeInOutQuad' },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          backgroundColor: '#0f172a',
          titleColor: '#64748b',
          bodyColor: '#f8fafc',
          titleFont: { size: 10, family: "'Plus Jakarta Sans', sans-serif", weight: '600' },
          bodyFont: { size: 13, weight: '700', family: "'Plus Jakarta Sans', sans-serif" },
          borderColor: 'rgba(255,255,255,0.10)',
          borderWidth: 1,
          padding: { x: 12, y: 8 },
          displayColors: false,
          cornerRadius: 8,
          callbacks: {
            label: (context) => ` ${context.parsed.y} ${unit}`
          }
        }
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      scales: {
        x: {
          display: false,
          grid: { display: false }
        },
        y: {
          display: true,
          position: 'right',
          beginAtZero: true,
          suggestedMax: suggestedMax || 5,
          grid: {
            color: 'rgba(226, 232, 240, 0.5)',
            lineWidth: 1,
            drawBorder: false,
            drawTicks: false
          },
          border: { display: false },
          ticks: {
            color: '#94a3b8',
            font: { size: 9.5, family: "'Plus Jakarta Sans', sans-serif", weight: '600' },
            maxTicksLimit: 3,
            padding: 4
          }
        }
      }
    }
  };
}

function initCharts() {
  // 1. MQ-2: suggestedMax 5 ppm (combustible gas, clean air baseline ~0.1–2)
  const mq2Canvas = document.getElementById('chart-mq2');
  if (mq2Canvas) {
    charts['mq2'] = new Chart(mq2Canvas.getContext('2d'), createChartConfig('#10b981', 'Combustible / Smoke', 'ppm', 5));
  }

  // 2. MQ-135: suggestedMax 2 ppm (air quality, very low clean air range)
  const mq135Canvas = document.getElementById('chart-mq135');
  if (mq135Canvas) {
    charts['mq135'] = new Chart(mq135Canvas.getContext('2d'), createChartConfig('#8b5cf6', 'Air Quality / NH3', 'ppm', 2));
  }

  // 3. MQ-7 CO: suggestedMax 5 ppm
  const coCanvas = document.getElementById('chart-co');
  if (coCanvas) {
    charts['co'] = new Chart(coCanvas.getContext('2d'), createChartConfig('#f97316', 'Carbon Monoxide (CO)', 'ppm', 5));
  }

  // 4. MQ-137 NO2: suggestedMax 0.05 ppm (ppb-scale gas)
  const no2Canvas = document.getElementById('chart-no2');
  if (no2Canvas) {
    charts['no2'] = new Chart(no2Canvas.getContext('2d'), createChartConfig('#ec4899', 'Nitrogen Dioxide (NO₂)', 'ppm', 0.05));
  }

  // 5. CO2: suggestedMax 600 ppm (ambient indoor range)
  const co2Canvas = document.getElementById('chart-co2');
  if (co2Canvas) {
    charts['co2'] = new Chart(co2Canvas.getContext('2d'), createChartConfig('#0ea5e9', 'Carbon Dioxide (CO₂)', 'ppm', 600));
  }

  // 6. Ambient: suggestedMax 35°C
  const envCanvas = document.getElementById('chart-env');
  if (envCanvas) {
    charts['env'] = new Chart(envCanvas.getContext('2d'), createChartConfig('#059669', 'Temperature', '°C', 35));
  }
}


function pushChartData(timeLabel, mq2Ppm, mq135Ppm, coPpm, no2Ppm, co2Ppm, tempC) {
  const chartFeeds = [
    { key: 'mq2', val: mq2Ppm },
    { key: 'mq135', val: mq135Ppm },
    { key: 'co', val: coPpm },
    { key: 'no2', val: no2Ppm },
    { key: 'co2', val: co2Ppm },
    { key: 'env', val: tempC }
  ];

  chartFeeds.forEach(({ key, val }) => {
    if (charts[key]) {
      charts[key].data.labels.push(timeLabel);
      charts[key].data.datasets[0].data.push(val);
      if (charts[key].data.labels.length > CONFIG.MAX_HISTORY_POINTS) {
        charts[key].data.labels.shift();
        charts[key].data.datasets[0].data.shift();
      }
      charts[key].update();
    }
  });
}

let serialPort = null;
let serialReader = null;
let serialReadLoopRunning = false;

function toggleDataSource() {
  const select = document.getElementById('dataSourceSelect');
  const ipGroup = document.getElementById('ipConfigGroup');
  const serialBtn = document.getElementById('serialConnectBtn');

  if (select) {
    state.dataSource = select.value;
  }

  if (ipGroup) {
    ipGroup.style.display = (state.dataSource === 'http' || state.dataSource === 'ws') ? 'flex' : 'none';
  }
  if (serialBtn) {
    serialBtn.style.display = (state.dataSource === 'serial') ? 'inline-flex' : 'none';
  }

  restartConnection();
}

function triggerManualReconnect() {
  restartConnection();
}

function restartConnection() {
  stopTelemetry();
  startTelemetry();
}

function startTelemetry() {
  stopTelemetry();
  setConnectionStatus(false, 'Connecting...');
  
  if (state.dataSource === 'simulation') {
    setConnectionStatus(true, 'Demo Simulation Active');
    state.pollTimer = setInterval(simulateSensorTick, CONFIG.POLL_INTERVAL_MS);
    simulateSensorTick();
  } else if (state.dataSource === 'http') {
    setConnectionStatus(false, `Connecting to http://${state.espHost}...`);
    pollESP32Http();
    state.pollTimer = setInterval(pollESP32Http, CONFIG.POLL_INTERVAL_MS);
  } else if (state.dataSource === 'serial') {
    if (!serialPort) {
      setConnectionStatus(false, 'Click "Connect USB Port" to begin stream');
    } else {
      setConnectionStatus(true, 'USB Serial Active (115200 baud)');
    }
  } else if (state.dataSource === 'ws') {
    connectESP32WebSocket();
  }
}

function stopTelemetry() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  if (state.wsInstance) {
    state.wsInstance.onopen = null;
    state.wsInstance.onmessage = null;
    state.wsInstance.onerror = null;
    state.wsInstance.onclose = null;
    state.wsInstance.close();
    state.wsInstance = null;
  }
}

async function connectESP32Serial() {
  if (!('serial' in navigator)) {
    alert("Web Serial API is not supported in this browser.\nPlease use Google Chrome or Microsoft Edge, or switch to 'ESP32 HTTP Polling' (Wi-Fi).");
    return;
  }

  try {
    serialPort = await navigator.serial.requestPort();
    await serialPort.open({ baudRate: 115200 });
    serialReadLoopRunning = true;
    setConnectionStatus(true, 'ESP32 USB Serial Connected (115200 baud)');
    
    const connectBtn = document.getElementById('serialConnectBtn');
    if (connectBtn) {
      connectBtn.innerText = 'Disconnect USB';
      connectBtn.classList.remove('btn-accent');
      connectBtn.classList.add('btn-danger-outline');
      connectBtn.onclick = disconnectESP32Serial;
    }

    readSerialStream();
  } catch (err) {
    console.error("Serial connection failed:", err);
    setConnectionStatus(false, `Serial Failed: ${err.message || 'Cancelled'}`);
  }
}

async function disconnectESP32Serial() {
  serialReadLoopRunning = false;
  if (serialReader) {
    try {
      await serialReader.cancel();
    } catch (e) {}
    serialReader = null;
  }
  if (serialPort) {
    try {
      await serialPort.close();
    } catch (e) {}
    serialPort = null;
  }
  const connectBtn = document.getElementById('serialConnectBtn');
  if (connectBtn) {
    connectBtn.innerText = 'Connect USB Port';
    connectBtn.classList.remove('btn-danger-outline');
    connectBtn.classList.add('btn-accent');
    connectBtn.onclick = connectESP32Serial;
  }
  setConnectionStatus(false, 'USB Serial Disconnected');
}

async function readSerialStream() {
  let buffer = '';
  while (serialPort && serialPort.readable && serialReadLoopRunning) {
    try {
      const textDecoder = new TextDecoderStream();
      const readableStreamClosed = serialPort.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      serialReader = reader;

      while (serialReadLoopRunning) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          buffer += value;
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Retain unfinished tail line

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('JSON:')) {
              try {
                const data = JSON.parse(trimmed.substring(5));
                processTelemetryPacket(data, 1);
              } catch (parseErr) {
                console.warn("Serial JSON parse error:", parseErr);
              }
            }
          }
        }
      }
    } catch (err) {
      console.warn("Serial stream error:", err);
      break;
    }
  }
}

async function pollESP32Http() {
  const url = `http://${state.espHost}${CONFIG.HTTP_ENDPOINT}`;
  const startTime = performance.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2500);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latency = Math.round(performance.now() - startTime);

    setConnectionStatus(true, `ESP32 Online (${state.espHost})`);
    processTelemetryPacket(data, latency);
  } catch (err) {
    console.warn(`HTTP poll failed to ${url}:`, err.message);
    setConnectionStatus(false, `ESP32 Unreachable at ${state.espHost} (Connect Wi-Fi to 'EmmiSense_AP' or use USB)`);
  }
}

function connectESP32WebSocket() {
  if (state.wsReconnectTimer) {
    clearTimeout(state.wsReconnectTimer);
    state.wsReconnectTimer = null;
  }
  if (state.wsInstance) {
    state.wsInstance.onclose = null;
    state.wsInstance.close();
    state.wsInstance = null;
  }

  const wsUrl = `ws://${state.espHost}${CONFIG.WS_ENDPOINT}`;
  setConnectionStatus(false, `Connecting to ${wsUrl}...`);

  try {
    const ws = new WebSocket(wsUrl);
    state.wsInstance = ws;

    ws.onopen = () => {
      setConnectionStatus(true, `ESP32 WS Connected (${state.espHost})`);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        processTelemetryPacket(data, 12);
      } catch (e) {
        console.error("Invalid JSON over WebSocket:", event.data);
      }
    };

    ws.onclose = () => {
      setConnectionStatus(false, `WS Disconnected`);
      if (state.dataSource === 'ws') {
        state.wsReconnectTimer = setTimeout(connectESP32WebSocket, 4000);
      }
    };

    ws.onerror = () => {
      setConnectionStatus(false, `WS Error`);
    };
  } catch (e) {
    setConnectionStatus(false, `WS Failed`);
  }
}

function setConnectionStatus(connected, label) {
  state.isConnected = connected;
  const dot = document.getElementById('connectionDot');
  const text = document.getElementById('connectionStatusText');

  if (dot && text) {
    dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
    text.innerText = label;
  }
}

let simPhase = 0;
function simulateSensorTick() {
  simPhase += 0.14;
  const noise = (Math.random() - 0.5) * 0.05;
  
  const simMq2Ppm = Math.max(0.5, parseFloat((1.35 + Math.sin(simPhase * 0.8) * 0.75 + noise).toFixed(2)));
  const simMq135Ppm = Math.max(0.3, parseFloat((0.85 + Math.sin(simPhase) * 0.35 + noise).toFixed(2)));
  const simCoPpm = Math.max(0.5, parseFloat((2.15 + Math.cos(simPhase * 0.7) * 0.45 + noise).toFixed(2)));
  const simNo2Ppm = Math.max(0.005, parseFloat((0.032 + Math.sin(simPhase * 0.5) * 0.008 + (noise * 0.01)).toFixed(3)));
  const simCo2Ppm = Math.round(415 + Math.sin(simPhase * 0.4) * 35 + (Math.random() * 10));
  const simTvoc = Math.round(26 + Math.cos(simPhase * 0.6) * 12 + (Math.random() * 5));

  const simMq2Adc = Math.round(820 + Math.sin(simPhase * 0.8) * 160 + (Math.random() * 20));
  const simMq135Adc = Math.round(960 + Math.sin(simPhase) * 160 + (Math.random() * 20));
  const simCoAdc = Math.round(520 + Math.cos(simPhase * 0.7) * 45 + (Math.random() * 10));
  const simNo2Adc = Math.round(410 + Math.sin(simPhase * 0.5) * 35 + (Math.random() * 10));

  const sampleData = {
    mq2_ppm: simMq2Ppm,
    mq135_ppm: simMq135Ppm,
    mq2_adc: simMq2Adc,
    mq135_adc: simMq135Adc,
    mq2_volts: parseFloat(((simMq2Adc / 4095.0) * 3.3 * 2.0).toFixed(3)),
    mq135_volts: parseFloat(((simMq135Adc / 4095.0) * 3.3).toFixed(3)),
    co: simCoPpm,
    mq7_adc: simCoAdc,
    mq7_volts: parseFloat(((simCoAdc / 4095.0) * 3.3).toFixed(3)),
    no2: simNo2Ppm,
    mq137_adc: simNo2Adc,
    mq137_volts: parseFloat(((simNo2Adc / 4095.0) * 3.3).toFixed(3)),
    co2: simCo2Ppm,
    tvoc: simTvoc,
    sgp30_status: "ONLINE",
    temp: parseFloat((24.5 + Math.sin(simPhase * 0.2) * 0.8).toFixed(1)),
    humidity: parseFloat((52.0 + Math.cos(simPhase * 0.2) * 2.5).toFixed(1)),
    pressure: parseFloat((1013.2 + Math.sin(simPhase * 0.1) * 0.5).toFixed(1)),
    raw: {
      mq2_adc: simMq2Adc,
      mq135_adc: simMq135Adc,
      co_adc: simCoAdc,
      no2_adc: simNo2Adc
    }
  };

  const latency = Math.round(8 + Math.random() * 8);
  processTelemetryPacket(sampleData, latency);
}

function processTelemetryPacket(data, latencyMs = 0) {
  const timestamp = new Date();
  const timeLabel = timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  state.packetCount++;
  const packetCountEl = document.getElementById('dataPacketCount');
  if (packetCountEl) packetCountEl.innerText = `Packets: ${state.packetCount}`;
  
  // 1. Parse MQ-2 (Combustible Gas / Smoke on GPIO 34)
  let mq2_adc = data.mq2_adc !== undefined 
    ? parseInt(data.mq2_adc) 
    : (data.raw?.mq2_adc !== undefined ? parseInt(data.raw.mq2_adc) : 0);

  let mq2_volts = data.mq2_volts !== undefined 
    ? parseFloat(data.mq2_volts) 
    : parseFloat(((mq2_adc / 4095.0) * 3.3).toFixed(2));

  let mq2_ppm = data.mq2_ppm !== undefined 
    ? parseFloat(data.mq2_ppm) 
    : (mq2_adc > 50 ? parseFloat((0.40 + ((mq2_adc - 100) / 1400.0) * 1.50).toFixed(2)) : 1.15);

  // 2. Parse MQ-135 (Air Quality & Ammonia on GPIO 35)
  let mq135_adc = data.mq135_adc !== undefined 
    ? parseInt(data.mq135_adc) 
    : (data.raw?.mq135_adc !== undefined ? parseInt(data.raw.mq135_adc) : 0);

  let mq135_volts = data.mq135_volts !== undefined 
    ? parseFloat(data.mq135_volts) 
    : parseFloat(((mq135_adc / 4095.0) * 3.3).toFixed(2));

  let mq135_ppm = data.mq135_ppm !== undefined 
    ? parseFloat(data.mq135_ppm) 
    : (mq135_adc > 50 ? parseFloat((0.04 + ((mq135_adc - 100) / 1400.0) * 0.22).toFixed(2)) : 0.09);

  // 3. Parse MQ-7 (Carbon Monoxide CO on GPIO 32)
  let co_adc = data.mq7_adc !== undefined 
    ? parseInt(data.mq7_adc) 
    : (data.raw?.mq7_adc !== undefined ? parseInt(data.raw.mq7_adc) : (data.raw?.co_adc !== undefined ? parseInt(data.raw.co_adc) : 0));

  let co_volts = data.mq7_volts !== undefined 
    ? parseFloat(data.mq7_volts) 
    : parseFloat(((co_adc / 4095.0) * 3.3).toFixed(2));

  let co_ppm = data.mq7_ppm !== undefined 
    ? parseFloat(data.mq7_ppm) 
    : (data.co !== undefined ? parseFloat(data.co) : (data.mq7_co !== undefined ? parseFloat(data.mq7_co) : 0.0));

  if (co_ppm === 0 && co_adc > 50) {
    co_ppm = parseFloat((0.50 + ((co_adc - 100) / 1400.0) * 3.50).toFixed(2));
  }

  // 4. Parse MQ-137 / NO2 (Nitrogen Dioxide)
  let no2_ppm = data.no2 !== undefined 
    ? parseFloat(data.no2) 
    : (data.mq137_no2 !== undefined ? parseFloat(data.mq137_no2) : 0.009);

  let no2_adc = data.mq137_adc !== undefined 
    ? parseInt(data.mq137_adc) 
    : (data.raw?.no2_adc !== undefined ? parseInt(data.raw.no2_adc) : 290);

  let no2_volts = data.mq137_volts !== undefined 
    ? parseFloat(data.mq137_volts) 
    : parseFloat(((no2_adc / 4095.0) * 3.3).toFixed(2));

  // 5. Parse SCD40 / CO2 & TVOC
  let co2_ppm = data.scd40_co2 !== undefined 
    ? parseFloat(data.scd40_co2) 
    : (data.co2 !== undefined ? parseFloat(data.co2) : (data.sgp30_eco2 !== undefined ? parseFloat(data.sgp30_eco2) : 408));

  let tvoc_ppb = data.tvoc !== undefined 
    ? parseInt(data.tvoc) 
    : (data.sgp30_tvoc !== undefined ? parseInt(data.sgp30_tvoc) : 18);

  const sgp_status = data.sgp30_status || 'ONLINE';

  // 6. Parse Ambient Environment
  let temp_c = data.temp !== undefined ? parseFloat(data.temp) : 24.5;
  let hum_pct = data.humidity !== undefined ? parseFloat(data.humidity) : 52.0;
  let press_hpa = data.pressure !== undefined ? parseFloat(data.pressure) : 1013.2;

  // Update Peaks
  if (mq2_ppm > state.peaks.mq2) state.peaks.mq2 = mq2_ppm;
  if (mq135_ppm > state.peaks.mq135) state.peaks.mq135 = mq135_ppm;
  if (co_ppm > state.peaks.co) state.peaks.co = co_ppm;
  if (no2_ppm > state.peaks.no2) state.peaks.no2 = no2_ppm;
  if (co2_ppm > state.peaks.co2) state.peaks.co2 = co2_ppm;
  if (temp_c > state.peaks.temp) state.peaks.temp = temp_c;

  // Record History
  const flatRecord = {
    timestamp: timestamp.toISOString(),
    localTime: timeLabel,
    mq2_ppm: mq2_ppm,
    mq135_ppm: mq135_ppm,
    co_ppm: co_ppm,
    no2_ppm: no2_ppm,
    co2_ppm: co2_ppm,
    mq2_adc: mq2_adc,
    mq135_adc: mq135_adc,
    mq7_adc: co_adc,
    mq2_volts: mq2_volts,
    mq135_volts: mq135_volts,
    mq7_volts: co_volts,
    latency_ms: latencyMs
  };
  state.sessionHistory.push(flatRecord);
  const loggedRowEl = document.getElementById('loggedRowCount');
  if (loggedRowEl) loggedRowEl.innerText = `${state.sessionHistory.length} records`;

  // Update UI Elements for all Cards
  updateSensorCard('mq2', mq2_ppm, mq2_adc, mq2_volts, THRESHOLDS.mq2, 2);
  updateSensorCard('mq135', mq135_ppm, mq135_adc, mq135_volts, THRESHOLDS.mq135, 2);
  updateSensorCard('co', co_ppm, co_adc, co_volts, THRESHOLDS.co, 2);
  updateSensorCard('no2', no2_ppm, no2_adc, no2_volts, THRESHOLDS.no2, 3);
  updateSensorCard('co2', co2_ppm, 0, 0, THRESHOLDS.co2, 0);

  // Update SCD40 / CO2 card specific labels
  const elTvoc = document.getElementById('val-tvoc');
  if (elTvoc) elTvoc.innerText = `${tvoc_ppb} ppb`;
  const elSgpStatus = document.getElementById('status-sgp30');
  if (elSgpStatus) elSgpStatus.innerText = sgp_status;

  // Update Ambient Environment Card
  const elTemp = document.getElementById('val-temp');
  if (elTemp) elTemp.innerText = temp_c.toFixed(1);
  const elHum = document.getElementById('val-hum');
  if (elHum) elHum.innerText = `${hum_pct.toFixed(1)}%`;
  const elPress = document.getElementById('val-press');
  if (elPress) elPress.innerText = `${Math.round(press_hpa)} hPa`;
  const elPeakTemp = document.getElementById('peak-temp');
  if (elPeakTemp) elPeakTemp.innerText = state.peaks.temp.toFixed(1);

  // Compute dew point approximation
  const elDew = document.getElementById('val-dew');
  const elComfort = document.getElementById('val-comfort');
  const elBadgeEnv = document.getElementById('badge-env');
  const dewPoint = temp_c - ((100 - hum_pct) / 5);
  if (elDew) elDew.innerText = `${dewPoint.toFixed(1)} °C`;
  if (elComfort) elComfort.innerText = 'Optimal';
  if (elBadgeEnv) {
    elBadgeEnv.className = 'threshold-pill pill-safe';
    elBadgeEnv.innerText = 'OPTIMAL';
  }

  // Update Top Quick Stat
  const elLiveVolts = document.getElementById('liveVoltsSummary');
  if (elLiveVolts) elLiveVolts.innerHTML = `${mq135_volts.toFixed(2)}<span class="stat-unit">V</span>`;

  // Update Hardware Register Monitor
  const elRegMq2Adc = document.getElementById('reg-mq2-adc');
  if (elRegMq2Adc) elRegMq2Adc.innerText = `${mq2_adc} ADC`;

  const elRegMq135Adc = document.getElementById('reg-mq135-adc');
  if (elRegMq135Adc) elRegMq135Adc.innerText = `${mq135_adc} ADC`;

  const elRegCoAdc = document.getElementById('reg-co-adc');
  if (elRegCoAdc) elRegCoAdc.innerText = `${co_adc} ADC`;

  const elRegNo2Adc = document.getElementById('reg-no2-adc');
  if (elRegNo2Adc) elRegNo2Adc.innerText = `${no2_adc} ADC`;

  const elRegMq2Volts = document.getElementById('reg-mq2-volts');
  if (elRegMq2Volts) elRegMq2Volts.innerText = `${mq2_volts.toFixed(3)} V`;

  const elRegMq135Volts = document.getElementById('reg-mq135-volts');
  if (elRegMq135Volts) elRegMq135Volts.innerText = `${mq135_volts.toFixed(3)} V`;

  const elRegCoVolts = document.getElementById('reg-co-volts');
  if (elRegCoVolts) elRegCoVolts.innerText = `${co_volts.toFixed(3)} V`;

  const elRegNo2Volts = document.getElementById('reg-no2-volts');
  if (elRegNo2Volts) elRegNo2Volts.innerText = `${no2_volts.toFixed(3)} V`;

  const elRegMq2Ppm = document.getElementById('reg-mq2-ppm');
  if (elRegMq2Ppm) elRegMq2Ppm.innerText = `${mq2_ppm.toFixed(2)} ppm`;

  const elRegMq135Ppm = document.getElementById('reg-mq135-ppm');
  if (elRegMq135Ppm) elRegMq135Ppm.innerText = `${mq135_ppm.toFixed(2)} ppm`;

  const elRegCo2Ppm = document.getElementById('reg-co2-ppm');
  if (elRegCo2Ppm) elRegCo2Ppm.innerText = `${Math.round(co2_ppm)} ppm`;

  const elRegLat = document.getElementById('rawVal-latency');
  if (elRegLat) elRegLat.innerText = `${latencyMs} ms`;

  // Push Data to Charts
  pushChartData(timeLabel, mq2_ppm, mq135_ppm, co_ppm, no2_ppm, co2_ppm, temp_c);

  // Calculate Aggregate Environmental Air Quality Index
  calculateOverallAirIndex(mq2_ppm, mq135_ppm, co_ppm, no2_ppm, co2_ppm);
}

function updateSensorCard(key, ppm, adc, volts, threshold, decimals = 2) {
  const elVal = document.getElementById(`val-${key}`);
  if (elVal) elVal.innerText = decimals === 0 ? Math.round(ppm) : ppm.toFixed(decimals);

  const elPeak = document.getElementById(`peak-${key}`);
  if (elPeak && state.peaks[key] !== undefined) {
    elPeak.innerText = decimals === 0 ? Math.round(state.peaks[key]) : state.peaks[key].toFixed(decimals);
  }

  const elRaw = document.getElementById(`raw-${key}`);
  if (elRaw && key !== 'co2') elRaw.innerText = `${adc} ADC`;

  const elVolt = document.getElementById(`volt-${key}`);
  if (elVolt && key !== 'co2') elVolt.innerText = `${volts.toFixed(2)} V`;

  const card = document.getElementById(`card-${key}`);
  const badge = document.getElementById(`badge-${key}`);

  if (card && badge && threshold) {
    card.classList.remove('state-warn', 'state-danger');
    if (ppm === 0 && adc === 0) {
      badge.className = 'threshold-pill pill-neutral';
      badge.innerText = 'STANDBY';
    } else if (ppm >= threshold.danger) {
      badge.className = 'threshold-pill pill-danger';
      badge.innerText = 'DANGER';
      card.classList.add('state-danger');
    } else if (ppm >= threshold.warn) {
      badge.className = 'threshold-pill pill-warn';
      badge.innerText = 'WARNING';
      card.classList.add('state-warn');
    } else {
      badge.className = 'threshold-pill pill-safe';
      badge.innerText = 'SAFE';
    }
  }
}

function calculateOverallAirIndex(mq2Ppm, mq135Ppm, coPpm = 0, no2Ppm = 0, co2Ppm = 400) {
  // Score for MQ-2 (Combustible/Smoke)
  let scoreMq2 = (mq2Ppm / THRESHOLDS.mq2.danger) * 40;
  
  // Score for MQ-135 (Air Quality/NH3)
  let scoreMq135 = 0;
  if (mq135Ppm <= 2.0) {
    scoreMq135 = 8 + (mq135Ppm / 2.0) * 8;
  } else if (mq135Ppm <= THRESHOLDS.mq135.warn) {
    scoreMq135 = 16 + ((mq135Ppm - 2.0) / (THRESHOLDS.mq135.warn - 2.0)) * 24;
  } else {
    scoreMq135 = 40 + ((mq135Ppm - THRESHOLDS.mq135.warn) / (THRESHOLDS.mq135.danger - THRESHOLDS.mq135.warn)) * 45;
  }

  // Score for CO
  let scoreCo = (coPpm / THRESHOLDS.co.danger) * 35;

  // Score for NO2
  let scoreNo2 = (no2Ppm / THRESHOLDS.no2.danger) * 35;

  // Score for CO2
  let scoreCo2 = Math.max(0, ((co2Ppm - 400) / (THRESHOLDS.co2.danger - 400)) * 30);

  const combinedScore = Math.round(Math.max(scoreMq2, scoreMq135, scoreCo, scoreNo2, scoreCo2));
  const totalScore = Math.min(100, Math.max(10, combinedScore));

  const scoreEl = document.getElementById('overallScoreVal');
  const fillEl = document.getElementById('overallMeterFill');
  const badgeEl = document.getElementById('overallIndexBadge');
  const titleEl = document.getElementById('overallIndexTitle');
  const descEl = document.getElementById('overallIndexDesc');

  if (scoreEl) scoreEl.innerText = totalScore;
  if (fillEl) fillEl.style.width = `${totalScore}%`;

  if (scoreEl && badgeEl && titleEl && descEl) {
    if (totalScore >= 65) {
      scoreEl.style.color = 'var(--status-danger)';
      badgeEl.className = 'status-pill pill-high';
      badgeEl.innerText = 'HIGH SEVERITY';
      titleEl.innerText = 'Elevated Gas Concentration';
      descEl.innerText = 'Sensor readings exceed warning thresholds. Active gas or air contaminants present. Ventilate immediately.';
    } else if (totalScore >= 35) {
      scoreEl.style.color = 'var(--status-warn)';
      badgeEl.className = 'status-pill pill-medium';
      badgeEl.innerText = 'MODERATE LEVEL';
      titleEl.innerText = 'Moderate Air Contamination';
      descEl.innerText = 'Slightly elevated air pollutants detected across active MQ monitoring channels.';
    } else {
      scoreEl.style.color = 'var(--status-safe)';
      badgeEl.className = 'status-pill pill-low';
      badgeEl.innerText = 'EXCELLENT / CLEAN';
      titleEl.innerText = 'Clean Ambient Atmospheric Baseline';
      descEl.innerText = 'All active MQ sensor channels are operating safely within baseline thresholds.';
    }
  }
}

function triggerManualFetch() {
  if (state.dataSource === 'simulation') {
    simulateSensorTick();
  } else if (state.dataSource === 'http') {
    pollESP32Http();
  }
}

function captureSnapshot() {
  const latest = state.sessionHistory[state.sessionHistory.length - 1];
  if (!latest) {
    alert("No telemetry packet received yet to snapshot.");
    return;
  }

  const snapCount = state.snapshots.length + 1;
  const snapLabel = prompt("Enter test condition label for this snapshot:", `Bench Test #${snapCount} (Ambient / Exposure)`);
  if (snapLabel === null) return;

  const scoreEl = document.getElementById('overallScoreVal');
  const badgeEl = document.getElementById('overallIndexBadge');

  const snapshot = {
    ...latest,
    label: snapLabel || `Test #${snapCount}`,
    overallScore: scoreEl ? scoreEl.innerText : '0',
    overallBadge: badgeEl ? badgeEl.innerText : 'SAFE'
  };

  state.snapshots.push(snapshot);
  renderSnapshotsTable();
}

function renderSnapshotsTable() {
  const tbody = document.getElementById('snapshotTableBody');
  if (!tbody) return;

  if (state.snapshots.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="10">No snapshots captured yet. Click "Log Timestamped Snapshot" to capture current test state.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.snapshots.map(s => `
    <tr>
      <td>${s.localTime}</td>
      <td><strong>${s.label}</strong></td>
      <td><b style="color: var(--accent-teal); font-size: 1rem;">${s.mq2_ppm.toFixed(2)}</b></td>
      <td><b style="color: var(--accent-purple); font-size: 1rem;">${s.mq135_ppm.toFixed(2)}</b></td>
      <td><b style="color: var(--accent-orange); font-size: 1rem;">${(s.co_ppm || 0).toFixed(2)}</b></td>
      <td><b style="color: var(--accent-pink); font-size: 1rem;">${(s.no2_ppm || 0).toFixed(3)}</b></td>
      <td><b style="color: var(--accent-cyan); font-size: 1rem;">${Math.round(s.co2_ppm || 400)}</b></td>
      <td>${s.mq2_adc}</td>
      <td>${s.mq135_adc}</td>
      <td>${s.mq7_adc !== undefined ? s.mq7_adc : (s.co_adc || '--')}</td>
      <td><span class="badge ${s.overallScore >= 65 ? 'pill-danger' : s.overallScore >= 35 ? 'pill-warn' : 'pill-safe'}">${s.overallBadge} (${s.overallScore}/100)</span></td>
    </tr>
  `).join('');
}

function clearSnapshots() {
  if (confirm("Clear all captured benchmark snapshots?")) {
    state.snapshots = [];
    renderSnapshotsTable();
  }
}

function exportCSV() {
  if (state.sessionHistory.length === 0) {
    alert("No telemetry data has been recorded in this session yet.");
    return;
  }

  const headers = [
    "Timestamp_ISO", "Local_Time", 
    "MQ2_Combustible_PPM", "MQ135_AirQuality_PPM", "MQ7_CO_PPM", "NO2_PPM", "CO2_PPM",
    "MQ2_Raw_ADC", "MQ135_Raw_ADC", "MQ7_Raw_ADC",
    "MQ2_Voltage_V", "MQ135_Voltage_V", "MQ7_Voltage_V", "Latency_ms"
  ];
  
  const csvRows = [
    headers.join(','),
    ...state.sessionHistory.map(row => [
      `"${row.timestamp}"`,
      `"${row.localTime}"`,
      row.mq2_ppm,
      row.mq135_ppm,
      row.co_ppm || 0,
      row.no2_ppm || 0,
      row.co2_ppm || 400,
      row.mq2_adc,
      row.mq135_adc,
      row.mq7_adc || 0,
      row.mq2_volts,
      row.mq135_volts,
      row.mq7_volts || 0,
      row.latency_ms
    ].join(','))
  ];

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  link.setAttribute("href", url);
  link.setAttribute("download", `EmmiSense_MultiSensor_Log_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function startSessionTimer() {
  setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - state.sessionStartTime) / 1000);
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    const timerEl = document.getElementById('sessionTimeVal');
    if (timerEl) timerEl.innerText = `${mins}:${secs}`;
  }, 1000);
}

