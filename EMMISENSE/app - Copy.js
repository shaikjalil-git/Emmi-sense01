// /**
//  * ========================================================================================
//  * EMMISENSE — VEHICLE EXHAUST GAS MONITORING CONTROLLER
//  * 
//  * Target ESP32 JSON Schema Expected over HTTP GET /api/data or WebSocket ws://<ip>/ws :
//  * {
//  *   "co": 12.4,        // MiCS-6814 Carbon Monoxide (ppm)
//  *   "no2": 0.03,       // MiCS-6814 Nitrogen Dioxide (ppm)
//  *   "nh3": 1.2,        // MiCS-6814 Ammonia (ppm)
//  *   "voc": 45,         // MiCS-6814 / Derived Total VOCs (ppb or index)
//  *   "co2": 612,        // SCD41 Carbon Dioxide (ppm)
//  *   "temp": 28.5,      // BME688 Temperature (°C) [optional]
//  *   "humidity": 55,    // BME688 Humidity (%) [optional]
//  *   "pressure": 1008,  // BME688 Barometric Pressure (hPa) [optional]
//  *   "raw": {           // Optional raw diagnostic registers for bench testing
//  *     "co_adc": 1845,
//  *     "no2_adc": 2310,
//  *     "nh3_adc": 1120,
//  *     "gas_res": 142.5
//  *   }
//  * }
//  * ========================================================================================
//  */

// // ==========================================================================
// // CONFIGURATION & GLOBAL STATE
// // ==========================================================================

// const CONFIG = {
//   // [CONFIGURE ESP32 ADDRESS HERE]
//   // Default fallback IP address or mDNS hostname of your ESP32 webserver:
//   DEFAULT_ESP32_HOST: "192.168.4.1", 
//   HTTP_ENDPOINT: "/api/data",        // or "/" depending on ESP32 webserver route
//   WS_ENDPOINT: "/ws",
//   POLL_INTERVAL_MS: 3000,           // 3.0 seconds
//   MAX_HISTORY_POINTS: 100,          // ~5 minutes of readings at 3s interval (60/3 * 5 = 100)
// };

// // Thresholds for safety rating
// let THRESHOLDS = {
//   co: { warn: 9.0, danger: 25.0 },     // OSHA/EPA typical limits
//   no2: { warn: 0.05, danger: 0.20 },   // Low concentrations are toxic
//   nh3: { warn: 15.0, danger: 35.0 },
//   voc: { warn: 150, danger: 300 },
//   co2: { warn: 1000, danger: 2500 }
// };

// // Application State
// let state = {
//   dataSource: 'simulation', // 'simulation', 'http', 'ws'
//   espHost: CONFIG.DEFAULT_ESP32_HOST,
//   isConnected: false,
//   pollTimer: null,
//   wsInstance: null,
//   packetCount: 0,
//   sessionStartTime: Date.now(),
//   sessionHistory: [], // stores all packets for CSV export
//   snapshots: [],      // manual test bench logs
//   peaks: {
//     co: 0,
//     no2: 0,
//     nh3: 0,
//     voc: 0,
//     co2: 0
//   },
//   hasEnvSensor: false
// };

// // Chart instances dictionary
// const charts = {};

// // ==========================================================================
// // INITIALIZATION
// // ==========================================================================

// document.addEventListener('DOMContentLoaded', () => {
//   loadStoredSettings();
//   initCharts();
//   startSessionTimer();
  
//   // Set default initial data source
//   const sourceSelector = document.getElementById('dataSourceSelect');
//   if (sourceSelector) {
//     state.dataSource = sourceSelector.value;
//   }

//   // Update ESP32 Host from UI
//   const ipInput = document.getElementById('espIpInput');
//   if (ipInput) {
//     state.espHost = ipInput.value.trim() || CONFIG.DEFAULT_ESP32_HOST;
//     ipInput.addEventListener('change', (e) => {
//       state.espHost = e.target.value.trim() || CONFIG.DEFAULT_ESP32_HOST;
//       localStorage.setItem('emmisense_esp_host', state.espHost);
//       restartConnection();
//     });
//   }

//   // Start telemetry loop
//   startTelemetry();
// });

// // ==========================================================================
// // LOCAL STORAGE & SETTINGS MANAGEMENT
// // ==========================================================================

// function loadStoredSettings() {
//   const savedHost = localStorage.getItem('emmisense_esp_host');
//   if (savedHost) {
//     state.espHost = savedHost;
//     const ipInput = document.getElementById('espIpInput');
//     if (ipInput) ipInput.value = savedHost;
//   }

//   const savedThresholds = localStorage.getItem('emmisense_thresholds');
//   if (savedThresholds) {
//     try {
//       THRESHOLDS = JSON.parse(savedThresholds);
//       applyThresholdsToUI();
//     } catch (e) {
//       console.warn("Failed to parse saved thresholds:", e);
//     }
//   }
// }

// function applyThresholdsToUI() {
//   for (const [gas, val] of Object.entries(THRESHOLDS)) {
//     const wInput = document.getElementById(`cfg-warn-${gas}`);
//     const dInput = document.getElementById(`cfg-dang-${gas}`);
//     const wLimLabel = document.getElementById(`lim-warn-${gas}`);
//     const dLimLabel = document.getElementById(`lim-dang-${gas}`);

//     if (wInput) wInput.value = val.warn;
//     if (dInput) dInput.value = val.danger;
//     if (wLimLabel) wLimLabel.innerText = val.warn;
//     if (dLimLabel) dLimLabel.innerText = val.danger;
//   }
// }

// function saveThresholds() {
//   for (const gas of ['co', 'no2', 'nh3', 'voc', 'co2']) {
//     const w = parseFloat(document.getElementById(`cfg-warn-${gas}`)?.value);
//     const d = parseFloat(document.getElementById(`cfg-dang-${gas}`)?.value);
//     if (!isNaN(w) && !isNaN(d)) {
//       THRESHOLDS[gas] = { warn: w, danger: d };
//     }
//   }
//   localStorage.setItem('emmisense_thresholds', JSON.stringify(THRESHOLDS));
//   applyThresholdsToUI();
// }

// function resetDefaultThresholds() {
//   THRESHOLDS = {
//     co: { warn: 9.0, danger: 25.0 },
//     no2: { warn: 0.05, danger: 0.20 },
//     nh3: { warn: 15.0, danger: 35.0 },
//     voc: { warn: 150, danger: 300 },
//     co2: { warn: 1000, danger: 2500 }
//   };
//   localStorage.removeItem('emmisense_thresholds');
//   applyThresholdsToUI();
// }

// // ==========================================================================
// // CHART.JS INITIALIZATION (Rolling 5-min Real-time Line Graphs)
// // ==========================================================================

// function createChartConfig(colorHex, label, unit) {
//   return {
//     type: 'line',
//     data: {
//       labels: [],
//       datasets: [{
//         label: `${label} (${unit})`,
//         data: [],
//         borderColor: colorHex,
//         backgroundColor: colorHex + '14', // 8% opacity soft fill
//         borderWidth: 2.2,
//         tension: 0.35,
//         fill: true,
//         pointRadius: 0,
//         pointHoverRadius: 4,
//         pointHitRadius: 10,
//         pointBackgroundColor: colorHex
//       }]
//     },
//     options: {
//       responsive: true,
//       maintainAspectRatio: false,
//       animation: false,
//       plugins: {
//         legend: { display: false },
//         tooltip: {
//           backgroundColor: '#0f172a',
//           titleColor: '#94a3b8',
//           bodyColor: '#ffffff',
//           titleFont: { size: 11, family: "'Plus Jakarta Sans', sans-serif" },
//           bodyFont: { size: 12, weight: 'bold', family: "'Plus Jakarta Sans', sans-serif" },
//           borderColor: 'rgba(255,255,255,0.08)',
//           borderWidth: 1,
//           padding: 8,
//           displayColors: false,
//           cornerRadius: 6,
//           callbacks: {
//             label: (context) => `${context.parsed.y} ${unit}`
//           }
//         }
//       },
//       scales: {
//         x: {
//           display: false,
//           grid: { display: false }
//         },
//         y: {
//           display: true,
//           position: 'right',
//           grid: {
//             color: '#f1f5f9',
//             drawBorder: false
//           },
//           ticks: {
//             color: '#94a3b8',
//             font: { size: 9, family: "'Plus Jakarta Sans', sans-serif", weight: '500' },
//             maxTicksLimit: 4
//           }
//         }
//       }
//     }
//   };
// }

// function initCharts() {
//   const chartConfigs = {
//     'co': { color: '#10b981', label: 'CO', unit: 'ppm' },
//     'no2': { color: '#0ea5e9', label: 'NO2', unit: 'ppm' },
//     'nh3': { color: '#8b5cf6', label: 'NH3', unit: 'ppm' },
//     'voc': { color: '#ec4899', label: 'VOCs', unit: 'ppb' },
//     'co2': { color: '#f97316', label: 'CO2', unit: 'ppm' }
//   };

//   for (const [key, cfg] of Object.entries(chartConfigs)) {
//     const canvas = document.getElementById(`chart-${key}`);
//     if (canvas) {
//       charts[key] = new Chart(canvas.getContext('2d'), createChartConfig(cfg.color, cfg.label, cfg.unit));
//     }
//   }

//   // Environmental Multi-dataset Chart (Temp & Humidity)
//   const envCanvas = document.getElementById('chart-env');
//   if (envCanvas) {
//     charts['env'] = new Chart(envCanvas.getContext('2d'), {
//       type: 'line',
//       data: {
//         labels: [],
//         datasets: [
//           {
//             label: 'Temp (°C)',
//             data: [],
//             borderColor: '#0ea5e9',
//             borderWidth: 2.2,
//             tension: 0.35,
//             pointRadius: 0,
//             yAxisID: 'y'
//           },
//           {
//             label: 'Humidity (%)',
//             data: [],
//             borderColor: '#10b981',
//             borderWidth: 2.2,
//             tension: 0.35,
//             pointRadius: 0,
//             yAxisID: 'y1'
//           }
//         ]
//       },
//       options: {
//         responsive: true,
//         maintainAspectRatio: false,
//         animation: false,
//         plugins: { legend: { display: false } },
//         scales: {
//           x: { display: false },
//           y: {
//             display: true,
//             position: 'left',
//             grid: { color: '#f1f5f9' },
//             ticks: { color: '#0ea5e9', font: { size: 9, family: "'Plus Jakarta Sans', sans-serif" }, maxTicksLimit: 3 }
//           },
//           y1: {
//             display: true,
//             position: 'right',
//             grid: { display: false },
//             ticks: { color: '#10b981', font: { size: 9, family: "'Plus Jakarta Sans', sans-serif" }, maxTicksLimit: 3 }
//           }
//         }
//       }
//     });
//   }
// }

// function pushChartData(chartKey, timeLabel, value) {
//   const chart = charts[chartKey];
//   if (!chart) return;

//   chart.data.labels.push(timeLabel);
//   chart.data.datasets[0].data.push(value);

//   if (chart.data.labels.length > CONFIG.MAX_HISTORY_POINTS) {
//     chart.data.labels.shift();
//     chart.data.datasets[0].data.shift();
//   }
//   chart.update();
// }

// function pushEnvChartData(timeLabel, temp, hum) {
//   const chart = charts['env'];
//   if (!chart) return;

//   chart.data.labels.push(timeLabel);
//   chart.data.datasets[0].data.push(temp);
//   chart.data.datasets[1].data.push(hum);

//   if (chart.data.labels.length > CONFIG.MAX_HISTORY_POINTS) {
//     chart.data.labels.shift();
//     chart.data.datasets[0].data.shift();
//     chart.data.datasets[1].data.shift();
//   }
//   chart.update();
// }

// // ==========================================================================
// // TELEMETRY CONNECTION CONTROLLER (HTTP / WebSocket / Simulation)
// // ==========================================================================

// function toggleDataSource() {
//   const select = document.getElementById('dataSourceSelect');
//   state.dataSource = select.value;
//   restartConnection();
// }

// function triggerManualReconnect() {
//   restartConnection();
// }

// function restartConnection() {
//   stopTelemetry();
//   startTelemetry();
// }

// function startTelemetry() {
//   setConnectionStatus(false, 'Connecting...');
  
//   if (state.dataSource === 'simulation') {
//     setConnectionStatus(true, 'Demo Simulation Active');
//     state.pollTimer = setInterval(simulateSensorTick, CONFIG.POLL_INTERVAL_MS);
//     simulateSensorTick(); // immediate first packet
//   } else if (state.dataSource === 'http') {
//     pollESP32Http();
//     state.pollTimer = setInterval(pollESP32Http, CONFIG.POLL_INTERVAL_MS);
//   } else if (state.dataSource === 'ws') {
//     connectESP32WebSocket();
//   }
// }

// function stopTelemetry() {
//   if (state.pollTimer) {
//     clearInterval(state.pollTimer);
//     state.pollTimer = null;
//   }
//   if (state.wsInstance) {
//     state.wsInstance.close();
//     state.wsInstance = null;
//   }
// }

// // --- HTTP Polling Mode ---
// async function pollESP32Http() {
//   const url = `http://${state.espHost}${CONFIG.HTTP_ENDPOINT}`;
//   const startTime = performance.now();

//   try {
//     const controller = new AbortController();
//     const timeoutId = setTimeout(() => controller.abort(), 2500);

//     const response = await fetch(url, { signal: controller.signal });
//     clearTimeout(timeoutId);

//     if (!response.ok) throw new Error(`HTTP ${response.status}`);
//     const data = await response.json();
//     const latency = Math.round(performance.now() - startTime);

//     setConnectionStatus(true, `ESP32 HTTP (${state.espHost})`);
//     processTelemetryPacket(data, latency);
//   } catch (err) {
//     console.warn(`HTTP poll failed to ${url}:`, err.message);
//     setConnectionStatus(false, `ESP32 Unreachable (${state.espHost})`);
//   }
// }

// // --- WebSocket Mode ---
// function connectESP32WebSocket() {
//   const wsUrl = `ws://${state.espHost}${CONFIG.WS_ENDPOINT}`;
//   setConnectionStatus(false, `Connecting to ${wsUrl}...`);

//   try {
//     state.wsInstance = new WebSocket(wsUrl);

//     state.wsInstance.onopen = () => {
//       setConnectionStatus(true, `ESP32 WS Connected (${state.espHost})`);
//     };

//     state.wsInstance.onmessage = (event) => {
//       try {
//         const data = JSON.parse(event.data);
//         processTelemetryPacket(data, 12);
//       } catch (e) {
//         console.error("Invalid JSON over WebSocket:", event.data);
//       }
//     };

//     state.wsInstance.onclose = () => {
//       setConnectionStatus(false, `WS Disconnected`);
//       // Auto reconnect after 4 seconds if in WS mode
//       if (state.dataSource === 'ws') {
//         state.pollTimer = setTimeout(connectESP32WebSocket, 4000);
//       }
//     };

//     state.wsInstance.onerror = () => {
//       setConnectionStatus(false, `WS Error`);
//     };
//   } catch (e) {
//     setConnectionStatus(false, `WS Failed`);
//   }
// }

// function setConnectionStatus(connected, label) {
//   state.isConnected = connected;
//   const dot = document.getElementById('connectionDot');
//   const text = document.getElementById('connectionStatusText');

//   if (dot && text) {
//     dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
//     text.innerText = label;
//   }
// }

// // ==========================================================================
// // SIMULATION ENGINE (Generates realistic vehicle exhaust fluctuations)
// // ==========================================================================

// let simPhase = 0;
// function simulateSensorTick() {
//   simPhase += 0.15;
//   // Realistic combustion exhaust gas simulation with slight stochastic noise
//   const noise = () => (Math.random() - 0.5) * 0.1;
//   const spike = Math.random() > 0.85 ? Math.random() * 4 : 0; // occasional throttle rev

//   const sampleData = {
//     co: Math.max(0.5, parseFloat((6.5 + Math.sin(simPhase) * 4.2 + spike + noise() * 2).toFixed(2))),
//     no2: Math.max(0.01, parseFloat((0.04 + Math.cos(simPhase * 0.8) * 0.03 + spike * 0.02 + noise() * 0.01).toFixed(3))),
//     nh3: Math.max(0.2, parseFloat((4.5 + Math.sin(simPhase * 0.5) * 3.0 + noise()).toFixed(2))),
//     voc: Math.max(10, Math.round(75 + Math.sin(simPhase * 1.2) * 50 + spike * 30 + (Math.random() * 10))),
//     co2: Math.max(400, Math.round(620 + Math.sin(simPhase * 0.4) * 350 + spike * 200)),
//     temp: parseFloat((32.5 + Math.sin(simPhase * 0.2) * 4.0 + noise()).toFixed(1)),
//     humidity: Math.round(48 + Math.cos(simPhase * 0.3) * 6),
//     pressure: Math.round(1012 + Math.sin(simPhase * 0.1) * 3),
//     raw: {
//       co_adc: Math.round(1600 + Math.sin(simPhase) * 400),
//       no2_adc: Math.round(2100 + Math.cos(simPhase) * 300),
//       nh3_adc: Math.round(1300 + Math.sin(simPhase * 0.5) * 200),
//       gas_res: parseFloat((120.4 + Math.sin(simPhase) * 15).toFixed(1))
//     }
//   };

//   const latency = Math.round(8 + Math.random() * 10);
//   processTelemetryPacket(sampleData, latency);
// }

// // ==========================================================================
// // TELEMETRY PACKET PROCESSOR & UI DISPATCH
// // ==========================================================================

// function processTelemetryPacket(data, latencyMs = 0) {
//   const timestamp = new Date();
//   const timeLabel = timestamp.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

//   state.packetCount++;
//   document.getElementById('dataPacketCount').innerText = `Packets: ${state.packetCount}`;
  
//   // Map incoming sensor keys (support both new MQ schema and legacy keys)
//   const co_val   = data.mq7_co !== undefined ? data.mq7_co : data.co;
//   const no2_val  = data.no2 !== undefined ? data.no2 : (data.mq135_aq !== undefined ? (parseFloat(data.mq135_aq) * 0.005).toFixed(3) : 0);
//   const nh3_val  = data.nh3 !== undefined ? data.nh3 : (data.mq135_aq !== undefined ? (parseFloat(data.mq135_aq) * 0.4).toFixed(2) : 0);
//   const voc_val  = data.mq2_lpg !== undefined ? data.mq2_lpg : data.voc;
//   const co2_val  = data.co2;

//   // Record in history log for CSV export
//   const flatRecord = {
//     timestamp: timestamp.toISOString(),
//     localTime: timeLabel,
//     co: co_val ?? '',
//     no2: no2_val ?? '',
//     nh3: nh3_val ?? '',
//     voc: voc_val ?? '',
//     co2: co2_val ?? '',
//     temp: data.temp ?? '',
//     humidity: data.humidity ?? '',
//     pressure: data.pressure ?? '',
//     latency_ms: latencyMs
//   };
//   state.sessionHistory.push(flatRecord);
//   document.getElementById('loggedRowCount').innerText = `${state.sessionHistory.length} records`;

//   // 1. Process Gas Readings
//   updateGasCard('co', co_val, timeLabel, 2);
//   updateGasCard('no2', no2_val, timeLabel, 3);
//   updateGasCard('nh3', nh3_val, timeLabel, 2);
//   updateGasCard('voc', voc_val, timeLabel, 0);
//   updateGasCard('co2', co2_val, timeLabel, 0);

//   // 2. Process BME688 Environmental Telemetry (if present)
//   if (data.temp !== undefined || data.humidity !== undefined || data.pressure !== undefined) {
//     state.hasEnvSensor = true;
//     document.getElementById('val-temp').innerText = data.temp !== undefined ? data.temp : '--';
//     document.getElementById('val-humidity').innerText = data.humidity !== undefined ? data.humidity : '--';
//     document.getElementById('val-pressure').innerText = data.pressure !== undefined ? data.pressure : '--';
    
//     document.getElementById('bmeTempSummary').innerHTML = `${data.temp !== undefined ? data.temp : '--'}<span class="stat-unit">°C</span>`;

//     if (data.temp !== undefined && data.humidity !== undefined) {
//       pushEnvChartData(timeLabel, data.temp, data.humidity);
//     }
//   }

//   // 3. Process Raw Debug / Registers
//   if (data.raw) {
//     if (data.raw.mq7_adc || data.raw.co_adc) document.getElementById('rawVal-co').innerText = `${data.raw.mq7_adc || data.raw.co_adc} ADC`;
//     if (data.raw.mq135_adc || data.raw.no2_adc) document.getElementById('rawVal-no2').innerText = `${data.raw.mq135_adc || data.raw.no2_adc} ADC`;
//     if (data.raw.mq2_adc || data.raw.nh3_adc) document.getElementById('rawVal-nh3').innerText = `${data.raw.mq2_adc || data.raw.nh3_adc} ADC`;
//     if (data.raw.gas_res) {
//       document.getElementById('rawVal-bme').innerText = `${data.raw.gas_res} kΩ`;
//       document.getElementById('raw-gasres').innerText = `${data.raw.gas_res} kΩ`;
//     }
//   } else {
//     // Generate derived estimate from calibrated values if raw key absent
//     document.getElementById('rawVal-co').innerText = `${Math.round((data.co || 0) * 120 + 800)} ADC`;
//     document.getElementById('rawVal-no2').innerText = `${Math.round((data.no2 || 0) * 8000 + 1200)} ADC`;
//     document.getElementById('rawVal-nh3').innerText = `${Math.round((data.nh3 || 0) * 150 + 600)} ADC`;
//   }

//   document.getElementById('rawVal-co2').innerText = `${data.co2 || 400} ppm (NDIR)`;
//   document.getElementById('rawVal-latency').innerText = `${latencyMs} ms`;

//   // 4. Calculate Overall Vehicle Pollution Index
//   calculateOverallPollutionIndex(data);
// }

// function updateGasCard(gasKey, val, timeLabel, precision = 2) {
//   if (val === undefined || val === null) return;
//   const numVal = parseFloat(val);

//   // Update Reading display
//   const valEl = document.getElementById(`val-${gasKey}`);
//   if (valEl) valEl.innerText = precision > 0 ? numVal.toFixed(precision) : Math.round(numVal);

//   // Track Peak
//   if (numVal > state.peaks[gasKey]) {
//     state.peaks[gasKey] = numVal;
//     const peakEl = document.getElementById(`peak-${gasKey}`);
//     if (peakEl) peakEl.innerText = precision > 0 ? numVal.toFixed(precision) : Math.round(numVal);
//   }

//   // Safety threshold status check
//   const thresh = THRESHOLDS[gasKey];
//   const card = document.getElementById(`card-${gasKey}`);
//   const badge = document.getElementById(`badge-${gasKey}`);

//   if (thresh && badge && card) {
//     card.classList.remove('state-warn', 'state-danger');
//     if (numVal >= thresh.danger) {
//       badge.className = 'threshold-pill pill-danger';
//       badge.innerText = 'DANGER';
//       card.classList.add('state-danger');
//     } else if (numVal >= thresh.warn) {
//       badge.className = 'threshold-pill pill-warn';
//       badge.innerText = 'WARNING';
//       card.classList.add('state-warn');
//     } else {
//       badge.className = 'threshold-pill pill-safe';
//       badge.innerText = 'SAFE';
//     }
//   }

//   // Push to chart
//   pushChartData(gasKey, timeLabel, numVal);
// }

// // ==========================================================================
// // OVERALL POLLUTION INDEX ALGORITHM
// // ==========================================================================

// function calculateOverallPollutionIndex(data) {
//   // Score formula: normalized weighted sum of ratio to danger limits
//   let scores = [];
  
//   if (data.co !== undefined) scores.push((data.co / THRESHOLDS.co.danger) * 35);
//   if (data.no2 !== undefined) scores.push((data.no2 / THRESHOLDS.no2.danger) * 30);
//   if (data.nh3 !== undefined) scores.push((data.nh3 / THRESHOLDS.nh3.danger) * 15);
//   if (data.voc !== undefined) scores.push((data.voc / THRESHOLDS.voc.danger) * 10);
//   if (data.co2 !== undefined) scores.push(((data.co2 - 400) / (THRESHOLDS.co2.danger - 400)) * 10);

//   const totalScore = Math.min(100, Math.max(5, Math.round(scores.reduce((a, b) => a + b, 0))));

//   const scoreEl = document.getElementById('overallScoreVal');
//   const fillEl = document.getElementById('overallMeterFill');
//   const badgeEl = document.getElementById('overallIndexBadge');
//   const titleEl = document.getElementById('overallIndexTitle');
//   const descEl = document.getElementById('overallIndexDesc');

//   scoreEl.innerText = totalScore;
//   fillEl.style.width = `${totalScore}%`;

//   if (totalScore >= 70) {
//     scoreEl.style.color = 'var(--status-danger)';
//     badgeEl.className = 'status-pill pill-high';
//     badgeEl.innerText = 'HIGH SEVERITY';
//     titleEl.innerText = 'Dangerous Exhaust Emission Level';
//     descEl.innerText = 'Combustion pollutants exceed critical safety limits. Check catalytic converter & engine air-fuel mix.';
//   } else if (totalScore >= 40) {
//     scoreEl.style.color = 'var(--status-warn)';
//     badgeEl.className = 'status-pill pill-medium';
//     badgeEl.innerText = 'ELEVATED WARNING';
//     titleEl.innerText = 'Moderate Exhaust Emission';
//     descEl.innerText = 'Elevated levels of NOx or CO detected. Vehicle is producing moderate exhaust pollutants.';
//   } else {
//     scoreEl.style.color = 'var(--status-safe)';
//     badgeEl.className = 'status-pill pill-low';
//     badgeEl.innerText = 'NORMAL / SAFE';
//     titleEl.innerText = 'Low Exhaust Emission';
//     descEl.innerText = 'All measured exhaust gases are within clean operating thresholds.';
//   }
// }

// // ==========================================================================
// // TEST BENCH: SNAPSHOT & MANUAL TRIGGER
// // ==========================================================================

// function triggerManualFetch() {
//   if (state.dataSource === 'simulation') {
//     simulateSensorTick();
//   } else if (state.dataSource === 'http') {
//     pollESP32Http();
//   }
// }

// function captureSnapshot() {
//   const latest = state.sessionHistory[state.sessionHistory.length - 1];
//   if (!latest) {
//     alert("No telemetry packet received yet to snapshot.");
//     return;
//   }

//   const snapCount = state.snapshots.length + 1;
//   const snapLabel = prompt("Enter test condition label for this snapshot:", `Test Benchmark #${snapCount} (Idle / Rev)`);
//   if (snapLabel === null) return; // cancelled

//   const snapshot = {
//     ...latest,
//     label: snapLabel || `Test #${snapCount}`,
//     overallScore: document.getElementById('overallScoreVal').innerText,
//     overallBadge: document.getElementById('overallIndexBadge').innerText
//   };

//   state.snapshots.push(snapshot);
//   renderSnapshotsTable();
// }

// function renderSnapshotsTable() {
//   const tbody = document.getElementById('snapshotTableBody');
//   if (!tbody) return;

//   if (state.snapshots.length === 0) {
//     tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No snapshots captured yet. Click "Log Timestamped Snapshot" to capture current test state.</td></tr>`;
//     return;
//   }

//   tbody.innerHTML = state.snapshots.map(s => `
//     <tr>
//       <td>${s.localTime}</td>
//       <td><strong>${s.label}</strong></td>
//       <td>${s.co}</td>
//       <td>${s.no2}</td>
//       <td>${s.nh3}</td>
//       <td>${s.voc}</td>
//       <td>${s.co2}</td>
//       <td>${s.temp || '--'}</td>
//       <td><span class="badge ${s.overallScore >= 70 ? 'pill-danger' : s.overallScore >= 40 ? 'pill-warn' : 'pill-safe'}">${s.overallBadge} (${s.overallScore}/100)</span></td>
//     </tr>
//   `).join('');
// }

// function clearSnapshots() {
//   if (confirm("Clear all captured benchmark snapshots?")) {
//     state.snapshots = [];
//     renderSnapshotsTable();
//   }
// }

// // ==========================================================================
// // CSV DATA EXPORT
// // ==========================================================================

// function exportCSV() {
//   if (state.sessionHistory.length === 0) {
//     alert("No telemetry data has been recorded in this session yet.");
//     return;
//   }

//   const headers = ["Timestamp_ISO", "Local_Time", "CO_ppm", "NO2_ppm", "NH3_ppm", "VOC_ppb", "CO2_ppm", "Temp_C", "Humidity_Pct", "Pressure_hPa", "Latency_ms"];
  
//   const csvRows = [
//     headers.join(','),
//     ...state.sessionHistory.map(row => [
//       `"${row.timestamp}"`,
//       `"${row.localTime}"`,
//       row.co,
//       row.no2,
//       row.nh3,
//       row.voc,
//       row.co2,
//       row.temp,
//       row.humidity,
//       row.pressure,
//       row.latency_ms
//     ].join(','))
//   ];

//   const csvContent = "data:text/csv;charset=utf-8," + csvRows.join("\n");
//   const encodedUri = encodeURI(csvContent);
//   const link = document.createElement("a");
//   const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
//   link.setAttribute("href", encodedUri);
//   link.setAttribute("download", `EmmiSense_Exhaust_Log_${dateStr}.csv`);
//   document.body.appendChild(link);
//   link.click();
//   document.body.removeChild(link);
// }

// // ==========================================================================
// // SESSION TIMER
// // ==========================================================================

// function startSessionTimer() {
//   setInterval(() => {
//     const elapsedSec = Math.floor((Date.now() - state.sessionStartTime) / 1000);
//     const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
//     const secs = String(elapsedSec % 60).padStart(2, '0');
//     document.getElementById('sessionTimeVal').innerText = `${mins}:${secs}`;
//   }, 1000);
// }
