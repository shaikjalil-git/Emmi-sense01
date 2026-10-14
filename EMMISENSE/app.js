/**
 * ========================================================================================
 * EMMISENSE — TRIPLE GAS SENSOR CONTROLLER (MQ-2, MQ-135, SGP30)
 * Active Sensors:
 * - MQ-2 (Combustible Gas / LPG / Smoke) on GPIO 34
 * - MQ-135 (Air Quality / NH3 / Ammonia) on GPIO 35
 * - SGP30 (TVOC & eCO2) on I2C (SDA GPIO 21 / SCL GPIO 22)
 * ========================================================================================
 */

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
  tvoc: { warn: 200, danger: 500 },
  eco2: { warn: 1000, danger: 2000 }
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
  peaks: { mq2: 0, mq135: 0, tvoc: 0, eco2: 0 }
};

const charts = {};

document.addEventListener('DOMContentLoaded', () => {
  loadStoredSettings();
  initCharts();
  startSessionTimer();
  
  const sourceSelector = document.getElementById('dataSourceSelect');
  if (sourceSelector) state.dataSource = sourceSelector.value;

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

  const savedThresholds = localStorage.getItem('emmisense_triple_thresholds');
  if (savedThresholds) {
    try {
      THRESHOLDS = JSON.parse(savedThresholds);
      applyThresholdsToUI();
    } catch (e) {
      console.warn("Failed to parse saved thresholds:", e);
    }
  }
}

function applyThresholdsToUI() {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };
  const setTxt = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.innerText = typeof val === 'number' ? val.toFixed(0) : val;
  };

  setVal('cfg-warn-mq2', THRESHOLDS.mq2.warn);
  setVal('cfg-dang-mq2', THRESHOLDS.mq2.danger);
  setVal('cfg-warn-mq135', THRESHOLDS.mq135.warn);
  setVal('cfg-dang-mq135', THRESHOLDS.mq135.danger);
  setVal('cfg-warn-tvoc', THRESHOLDS.tvoc.warn);
  setVal('cfg-dang-tvoc', THRESHOLDS.tvoc.danger);
  setVal('cfg-warn-eco2', THRESHOLDS.eco2.warn);
  setVal('cfg-dang-eco2', THRESHOLDS.eco2.danger);

  setTxt('lim-warn-mq2', THRESHOLDS.mq2.warn);
  setTxt('lim-dang-mq2', THRESHOLDS.mq2.danger);
  setTxt('lim-warn-mq135', THRESHOLDS.mq135.warn);
  setTxt('lim-dang-mq135', THRESHOLDS.mq135.danger);
  setTxt('lim-warn-tvoc', THRESHOLDS.tvoc.warn);
  setTxt('lim-dang-tvoc', THRESHOLDS.tvoc.danger);
  setTxt('lim-warn-eco2', THRESHOLDS.eco2.warn);
  setTxt('lim-dang-eco2', THRESHOLDS.eco2.danger);
}

function saveThresholds() {
  const parseEl = (id) => parseFloat(document.getElementById(id)?.value);
  const w2 = parseEl('cfg-warn-mq2'), d2 = parseEl('cfg-dang-mq2');
  const w135 = parseEl('cfg-warn-mq135'), d135 = parseEl('cfg-dang-mq135');
  const wTvoc = parseEl('cfg-warn-tvoc'), dTvoc = parseEl('cfg-dang-tvoc');
  const wEco2 = parseEl('cfg-warn-eco2'), dEco2 = parseEl('cfg-dang-eco2');

  if (!isNaN(w2) && !isNaN(d2) && !isNaN(w135) && !isNaN(d135) && !isNaN(wTvoc) && !isNaN(dTvoc) && !isNaN(wEco2) && !isNaN(dEco2)) {
    THRESHOLDS = {
      mq2: { warn: w2, danger: d2 },
      mq135: { warn: w135, danger: d135 },
      tvoc: { warn: wTvoc, danger: dTvoc },
      eco2: { warn: wEco2, danger: dEco2 }
    };
    localStorage.setItem('emmisense_triple_thresholds', JSON.stringify(THRESHOLDS));
    applyThresholdsToUI();
  }
}

function resetDefaultThresholds() {
  THRESHOLDS = {
    mq2: { warn: 15.0, danger: 35.0 },
    mq135: { warn: 15.0, danger: 35.0 },
    tvoc: { warn: 200, danger: 500 },
    eco2: { warn: 1000, danger: 2000 }
  };
  localStorage.removeItem('emmisense_triple_thresholds');
  applyThresholdsToUI();
}

function createChartConfig(colorHex, label, unit) {
  return {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: `${label} (${unit})`,
        data: [],
        borderColor: colorHex,
        backgroundColor: colorHex + '18',
        borderWidth: 2.6,
        tension: 0.35,
        fill: true,
        pointRadius: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          display: true,
          position: 'right',
          grid: { color: '#f1f5f9' },
          ticks: { color: '#94a3b8', font: { size: 10 } }
        }
      }
    }
  };
}

function initCharts() {
  const mq2Canvas = document.getElementById('chart-mq2');
  if (mq2Canvas) charts['mq2'] = new Chart(mq2Canvas.getContext('2d'), createChartConfig('#10b981', 'Combustible / Smoke', 'ppm'));

  const mq135Canvas = document.getElementById('chart-mq135');
  if (mq135Canvas) charts['mq135'] = new Chart(mq135Canvas.getContext('2d'), createChartConfig('#8b5cf6', 'Air Quality / NH3', 'ppm'));

  const tvocCanvas = document.getElementById('chart-tvoc');
  if (tvocCanvas) charts['tvoc'] = new Chart(tvocCanvas.getContext('2d'), createChartConfig('#f97316', 'SGP30 TVOC', 'ppb'));

  const eco2Canvas = document.getElementById('chart-eco2');
  if (eco2Canvas) charts['eco2'] = new Chart(eco2Canvas.getContext('2d'), createChartConfig('#0ea5e9', 'SGP30 eCO2', 'ppm'));
}

function pushChartData(timeLabel, mq2, mq135, tvoc, eco2) {
  const updateChart = (key, val) => {
    if (!charts[key]) return;
    charts[key].data.labels.push(timeLabel);
    charts[key].data.datasets[0].data.push(val);
    if (charts[key].data.labels.length > CONFIG.MAX_HISTORY_POINTS) {
      charts[key].data.labels.shift();
      charts[key].data.datasets[0].data.shift();
    }
    charts[key].update();
  };

  updateChart('mq2', mq2);
  updateChart('mq135', mq135);
  updateChart('tvoc', tvoc);
  updateChart('eco2', eco2);
}

function toggleDataSource() {
  const select = document.getElementById('dataSourceSelect');
  if (select) state.dataSource = select.value;
  restartConnection();
}

function triggerManualReconnect() { restartConnection(); }

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
    pollESP32Http();
    state.pollTimer = setInterval(pollESP32Http, CONFIG.POLL_INTERVAL_MS);
  } else if (state.dataSource === 'ws') {
    connectESP32WebSocket();
  }
}

function stopTelemetry() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  if (state.wsReconnectTimer) { clearTimeout(state.wsReconnectTimer); state.wsReconnectTimer = null; }
  if (state.wsInstance) {
    state.wsInstance.onclose = null;
    state.wsInstance.close();
    state.wsInstance = null;
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
    setConnectionStatus(false, `ESP32 Unreachable (${state.espHost})`);
  }
}

function connectESP32WebSocket() {
  if (state.wsReconnectTimer) clearTimeout(state.wsReconnectTimer);
  if (state.wsInstance) { state.wsInstance.onclose = null; state.wsInstance.close(); }

  const wsUrl = `ws://${state.espHost}${CONFIG.WS_ENDPOINT}`;
  setConnectionStatus(false, `Connecting to ${wsUrl}...`);

  try {
    const ws = new WebSocket(wsUrl);
    state.wsInstance = ws;
    ws.onopen = () => setConnectionStatus(true, `ESP32 WS Connected (${state.espHost})`);
    ws.onmessage = (e) => {
      try { processTelemetryPacket(JSON.parse(e.data), 12); } catch (err) {}
    };
    ws.onclose = () => {
      setConnectionStatus(false, `WS Disconnected`);
      if (state.dataSource === 'ws') state.wsReconnectTimer = setTimeout(connectESP32WebSocket, 4000);
    };
    ws.onerror = () => setConnectionStatus(false, `WS Error`);
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
  
  const simMq2Ppm = Math.max(0.1, parseFloat((1.2 + Math.sin(simPhase * 0.8) * 0.8 + noise).toFixed(2)));
  const simMq135Ppm = Math.max(0.3, parseFloat((0.85 + Math.sin(simPhase) * 0.35 + noise).toFixed(2)));
  const simTvoc = Math.round(45 + Math.sin(simPhase * 1.2) * 35 + Math.random() * 15);
  const simEco2 = Math.round(410 + Math.sin(simPhase * 0.5) * 180 + Math.random() * 25);

  const simMq2Adc = Math.round(850 + Math.sin(simPhase * 0.8) * 180);
  const simMq135Adc = Math.round(960 + Math.sin(simPhase) * 160);

  const sampleData = {
    mq2_ppm: simMq2Ppm,
    mq135_ppm: simMq135Ppm,
    mq2_adc: simMq2Adc,
    mq135_adc: simMq135Adc,
    mq2_volts: parseFloat(((simMq2Adc / 4095.0) * 3.3).toFixed(3)),
    mq135_volts: parseFloat(((simMq135Adc / 4095.0) * 3.3).toFixed(3)),
    sgp30_tvoc: simTvoc,
    sgp30_eco2: simEco2,
    sgp30_status: "ONLINE"
  };

  processTelemetryPacket(sampleData, Math.round(8 + Math.random() * 8));
}

function processTelemetryPacket(data, latencyMs = 0) {
  const timestamp = new Date();
  const timeLabel = timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  state.packetCount++;
  const packetCountEl = document.getElementById('dataPacketCount');
  if (packetCountEl) packetCountEl.innerText = `Packets: ${state.packetCount}`;

  const mq2_ppm = data.mq2_ppm !== undefined ? parseFloat(data.mq2_ppm) : 0.0;
  const mq135_ppm = data.mq135_ppm !== undefined ? parseFloat(data.mq135_ppm) : 0.65;
  const sgp_tvoc = data.sgp30_tvoc !== undefined ? parseInt(data.sgp30_tvoc) : 0;
  const sgp_eco2 = data.sgp30_eco2 !== undefined ? parseInt(data.sgp30_eco2) : 400;

  const mq2_adc = data.mq2_adc !== undefined ? parseInt(data.mq2_adc) : 800;
  const mq135_adc = data.mq135_adc !== undefined ? parseInt(data.mq135_adc) : 950;
  const mq2_volts = data.mq2_volts !== undefined ? parseFloat(data.mq2_volts) : parseFloat(((mq2_adc / 4095.0) * 3.3).toFixed(3));
  const mq135_volts = data.mq135_volts !== undefined ? parseFloat(data.mq135_volts) : parseFloat(((mq135_adc / 4095.0) * 3.3).toFixed(3));

  if (mq2_ppm > state.peaks.mq2) state.peaks.mq2 = mq2_ppm;
  if (mq135_ppm > state.peaks.mq135) state.peaks.mq135 = mq135_ppm;
  if (sgp_tvoc > state.peaks.tvoc) state.peaks.tvoc = sgp_tvoc;
  if (sgp_eco2 > state.peaks.eco2) state.peaks.eco2 = sgp_eco2;

  const flatRecord = {
    timestamp: timestamp.toISOString(),
    localTime: timeLabel,
    mq2_ppm, mq135_ppm, sgp_tvoc, sgp_eco2,
    mq2_adc, mq135_adc, mq2_volts, mq135_volts,
    latency_ms: latencyMs
  };
  state.sessionHistory.push(flatRecord);

  const loggedRowEl = document.getElementById('loggedRowCount');
  if (loggedRowEl) loggedRowEl.innerText = `${state.sessionHistory.length} records`;

  updateSensorCard('mq2', mq2_ppm, mq2_adc, mq2_volts, THRESHOLDS.mq2, 'ppm');
  updateSensorCard('mq135', mq135_ppm, mq135_adc, mq135_volts, THRESHOLDS.mq135, 'ppm');
  updateSensorCard('tvoc', sgp_tvoc, null, null, THRESHOLDS.tvoc, 'ppb');
  updateSensorCard('eco2', sgp_eco2, null, null, THRESHOLDS.eco2, 'ppm');

  const setReg = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
  setReg('reg-mq2-adc', `${mq2_adc} ADC`);
  setReg('reg-mq135-adc', `${mq135_adc} ADC`);
  setReg('reg-mq2-volts', `${mq2_volts.toFixed(3)} V`);
  setReg('reg-mq135-volts', `${mq135_volts.toFixed(3)} V`);
  setReg('reg-sgp-tvoc', `${sgp_tvoc} ppb`);
  setReg('reg-sgp-eco2', `${sgp_eco2} ppm`);
  setReg('reg-i2c-status', data.sgp30_status || 'OK');
  setReg('rawVal-latency', `${latencyMs} ms`);

  pushChartData(timeLabel, mq2_ppm, mq135_ppm, sgp_tvoc, sgp_eco2);
  calculateOverallAirIndex(mq2_ppm, mq135_ppm, sgp_tvoc, sgp_eco2);
}

function updateSensorCard(key, val, adc, volts, threshold, unit) {
  const elVal = document.getElementById(`val-${key}`);
  if (elVal) elVal.innerText = typeof val === 'number' && val % 1 !== 0 ? val.toFixed(2) : val;

  const elPeak = document.getElementById(`peak-${key}`);
  if (elPeak) elPeak.innerText = state.peaks[key];

  if (adc !== null) {
    const elRaw = document.getElementById(`raw-${key}`);
    if (elRaw) elRaw.innerText = `${adc} ADC`;
  }
  if (volts !== null) {
    const elVolt = document.getElementById(`volt-${key}`);
    if (elVolt) elVolt.innerText = `${volts.toFixed(2)} V`;
  }

  const card = document.getElementById(`card-${key}`);
  const badge = document.getElementById(`badge-${key}`);

  if (card && badge && threshold) {
    card.classList.remove('state-warn', 'state-danger');
    if (val >= threshold.danger) {
      badge.className = 'threshold-pill pill-danger';
      badge.innerText = 'DANGER';
      card.classList.add('state-danger');
    } else if (val >= threshold.warn) {
      badge.className = 'threshold-pill pill-warn';
      badge.innerText = 'WARNING';
      card.classList.add('state-warn');
    } else {
      badge.className = 'threshold-pill pill-safe';
      badge.innerText = 'SAFE';
    }
  }
}

function calculateOverallAirIndex(mq2Ppm, mq135Ppm, tvocPpb, eco2Ppm) {
  const scoreMq2 = (mq2Ppm / THRESHOLDS.mq2.danger) * 30;
  const scoreMq135 = (mq135Ppm / THRESHOLDS.mq135.danger) * 30;
  const scoreTvoc = (tvocPpb / THRESHOLDS.tvoc.danger) * 20;
  const scoreEco2 = Math.max(0, (eco2Ppm - 400) / (THRESHOLDS.eco2.danger - 400)) * 20;

  const totalScore = Math.min(100, Math.max(8, Math.round(scoreMq2 + scoreMq135 + scoreTvoc + scoreEco2)));

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
      titleEl.innerText = 'Elevated Contaminants / Gas Alert';
      descEl.innerText = 'Threshold limits exceeded on active gas sensors. Vent room atmosphere immediately.';
    } else if (totalScore >= 35) {
      scoreEl.style.color = 'var(--status-warn)';
      badgeEl.className = 'status-pill pill-medium';
      badgeEl.innerText = 'MODERATE LEVEL';
      titleEl.innerText = 'Moderate Air Pollution';
      descEl.innerText = 'Slightly elevated gas readings detected across active sampling channels.';
    } else {
      scoreEl.style.color = 'var(--status-safe)';
      badgeEl.className = 'status-pill pill-low';
      badgeEl.innerText = 'EXCELLENT / CLEAN';
      titleEl.innerText = 'Clean Ambient Atmospheric Baseline';
      descEl.innerText = 'MQ-2, MQ-135, and SGP30 are operating within optimal environmental parameters.';
    }
  }
}

function triggerManualFetch() {
  if (state.dataSource === 'simulation') simulateSensorTick();
  else if (state.dataSource === 'http') pollESP32Http();
}

function captureSnapshot() {
  const latest = state.sessionHistory[state.sessionHistory.length - 1];
  if (!latest) {
    alert("No telemetry packet recorded yet.");
    return;
  }

  const snapCount = state.snapshots.length + 1;
  const snapLabel = prompt("Enter snapshot test condition:", `Bench Test #${snapCount}`);
  if (snapLabel === null) return;

  const scoreEl = document.getElementById('overallScoreVal');
  const badgeEl = document.getElementById('overallIndexBadge');

  state.snapshots.push({
    ...latest,
    label: snapLabel || `Test #${snapCount}`,
    overallScore: scoreEl ? scoreEl.innerText : '0',
    overallBadge: badgeEl ? badgeEl.innerText : 'SAFE'
  });
  renderSnapshotsTable();
}

function renderSnapshotsTable() {
  const tbody = document.getElementById('snapshotTableBody');
  if (!tbody) return;

  if (state.snapshots.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No snapshots captured yet. Click "Log Timestamped Snapshot" to store current readings.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.snapshots.map(s => `
    <tr>
      <td>${s.localTime}</td>
      <td><strong>${s.label}</strong></td>
      <td><b style="color: var(--accent-teal);">${s.mq2_ppm.toFixed(2)} ppm</b></td>
      <td><b style="color: var(--accent-purple);">${s.mq135_ppm.toFixed(2)} ppm</b></td>
      <td><b style="color: var(--accent-orange);">${s.sgp_tvoc} ppb</b></td>
      <td><b style="color: var(--accent-cyan);">${s.sgp_eco2} ppm</b></td>
      <td>${s.mq2_adc} / ${s.mq135_adc}</td>
      <td>${s.mq2_volts.toFixed(2)} V / ${s.mq135_volts.toFixed(2)} V</td>
      <td><span class="badge ${s.overallScore >= 65 ? 'pill-danger' : s.overallScore >= 35 ? 'pill-warn' : 'pill-safe'}">${s.overallBadge} (${s.overallScore}/100)</span></td>
    </tr>
  `).join('');
}

function clearSnapshots() {
  if (confirm("Clear all snapshot logs?")) {
    state.snapshots = [];
    renderSnapshotsTable();
  }
}

function exportCSV() {
  if (state.sessionHistory.length === 0) {
    alert("No telemetry data has been logged in this session.");
    return;
  }

  const headers = ["Timestamp_ISO", "Local_Time", "MQ2_PPM", "MQ135_PPM", "SGP30_TVOC_ppb", "SGP30_eCO2_ppm", "MQ2_ADC", "MQ135_ADC", "MQ2_Volts", "MQ135_Volts", "Latency_ms"];
  
  const csvRows = [
    headers.join(','),
    ...state.sessionHistory.map(r => [
      `"${r.timestamp}"`, `"${r.localTime}"`,
      r.mq2_ppm, r.mq135_ppm, r.sgp_tvoc, r.sgp_eco2,
      r.mq2_adc, r.mq135_adc, r.mq2_volts, r.mq135_volts, r.latency_ms
    ].join(','))
  ];

  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `EmmiSense_TripleSensor_Log_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
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