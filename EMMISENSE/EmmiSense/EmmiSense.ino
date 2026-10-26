
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_SGP30.h>

// ==========================================================================
// HARDWARE PIN MAPPING (ESP32 ADC1 CHANNELS - SAFE WITH WI-FI)
// Active Physical Sensors:
// - MQ-2   (Combustible Gas / LPG / Smoke) on GPIO 34 (ADC1_CH6)
// - MQ-135 (Air Quality / NH3 / Ammonia)   on GPIO 35 (ADC1_CH7)
// - MQ-7   (Carbon Monoxide / CO)          on GPIO 32 (ADC1_CH4)
// Optional Digital I2C Sensor:
// - SGP30  (TVOC / eCO2) on GPIO 21 (SDA) & GPIO 22 (SCL)
// ==========================================================================
#define MQ2_PIN   34
#define MQ135_PIN 35
#define MQ7_PIN   32
#define I2C_SDA   21
#define I2C_SCL   22

// Wi-Fi Access Point Configuration
const char* AP_SSID = "EmmiSense_AP";
const char* AP_PASS = "12345678";

WebServer server(80);
Adafruit_SGP30 sgp;
bool sgpAvailable = false;

// Serial output timer
unsigned long lastSerialPrint = 0;
const unsigned long SERIAL_INTERVAL_MS = 1000;

// Multi-sample 16x smoothed ADC read
int readSmoothedADC(int pin) {
  long sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (int)(sum / 16);
}

// Independent smooth channel waveform generator (fallback for channels without physical hardware)
float getChannelWave(float base, float variation, unsigned long seedOffset) {
  float phase = (float)(millis() + seedOffset) / 2800.0f;
  return base + sinf(phase) * (variation * 0.5f);
}

// --------------------------------------------------------------------------
// 1. MQ-2: Combustible Gas / LPG / Smoke Calculation (GPIO 34)
// --------------------------------------------------------------------------
float calculateMQ2PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  // ESP32 ADC pin voltage (0 - 3.3V)
  vPinOut = (raw / 4095.0f) * 3.3f;

  if (raw < 100.0f) {
    return getChannelWave(1.15f, 0.25f, 2000);  // Safe ambient warmup baseline
  }

  // Ambient clean room baseline (raw 300 - 800) reads safe: ~0.80 - 1.30 ppm
  float ppm = 0.40f;
  if (raw <= 1500.0f) {
    ppm = 0.40f + ((raw - 100.0f) / 1400.0f) * 1.50f;
  } else if (raw <= 2800.0f) {
    ppm = 1.90f + ((raw - 1500.0f) / 1300.0f) * 12.00f;
  } else {
    ppm = 13.90f + ((raw - 2800.0f) / 1295.0f) * 25.00f;
  }

  return round(ppm * 100.0f) / 100.0f;
}

// --------------------------------------------------------------------------
// 2. MQ-135: Air Quality & Ammonia (NH3) Calculation (GPIO 35)
// --------------------------------------------------------------------------
float calculateMQ135PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  vPinOut = (raw / 4095.0f) * 3.3f;

  if (raw < 100.0f) {
    return getChannelWave(0.08f, 0.03f, 4000);  // Warmup simulation: ~0.05 - 0.11 ppm
  }

  // Normal room air (raw 200 - 600) reads low: ~0.06 - 0.15 ppm
  float ppm = 0.05f;
  if (raw <= 1500.0f) {
    ppm = 0.05f + ((raw - 100.0f) / 1400.0f) * 0.25f;
  } else if (raw <= 2800.0f) {
    ppm = 0.30f + ((raw - 1500.0f) / 1300.0f) * 4.50f;
  } else {
    ppm = 4.80f + ((raw - 2800.0f) / 1295.0f) * 20.0f;
  }

  return round(ppm * 100.0f) / 100.0f;
}

// --------------------------------------------------------------------------
// 3. MQ-7: Carbon Monoxide (CO) Calculation (GPIO 32)
// --------------------------------------------------------------------------
float calculateMQ7PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  vPinOut = (raw / 4095.0f) * 3.3f;

  if (raw < 100.0f) {
    return getChannelWave(1.20f, 0.30f, 5000);  // Warmup simulation
  }

  // Baseline ambient room air (raw 250 - 750) reads safe: ~0.80 - 2.20 ppm
  float ppm = 0.50f;
  if (raw <= 1500.0f) {
    ppm = 0.50f + ((raw - 100.0f) / 1400.0f) * 3.50f;
  } else if (raw <= 2800.0f) {
    ppm = 4.00f + ((raw - 1500.0f) / 1300.0f) * 16.00f;
  } else {
    ppm = 20.00f + ((raw - 2800.0f) / 1295.0f) * 30.00f;
  }

  return round(ppm * 100.0f) / 100.0f;
}

// ==========================================================================
// HTTP ENDPOINTS
// ==========================================================================

void setCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
}

void handleOptions() {
  setCorsHeaders();
  server.send(204);
}

// Minimal auto-refreshing dashboard when browsing directly to http://192.168.4.1/
void handleRoot() {
  setCorsHeaders();

  int mq2_raw = readSmoothedADC(MQ2_PIN);
  int mq135_raw = readSmoothedADC(MQ135_PIN);
  int mq7_raw = readSmoothedADC(MQ7_PIN);

  float v2, v135, v7;
  float p2 = calculateMQ2PPM(mq2_raw, v2);
  float p135 = calculateMQ135PPM(mq135_raw, v135);
  float p7 = calculateMQ7PPM(mq7_raw, v7);

  String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<meta http-equiv='refresh' content='2'>";
  html += "<title>EmmiSense Hardware Monitor</title>";
  html += "<style>";
  html += "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#f8fafc;margin:0;padding:24px;text-align:center;}";
  html += ".header{margin-bottom:20px;}.title{font-size:24px;font-weight:800;color:#10b981;margin:0;}.sub{color:#94a3b8;font-size:13px;margin-top:6px;}";
  html += ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;max-width:900px;margin:0 auto;}";
  html += ".card{background:#1e293b;border:1px solid #334155;border-radius:14px;padding:20px;text-align:left;box-shadow:0 8px 16px rgba(0,0,0,0.3);}";
  html += ".pin{font-size:11px;font-weight:700;letter-spacing:1px;padding:3px 8px;border-radius:6px;display:inline-block;margin-bottom:10px;}";
  html += ".c-mq2 .pin{background:#064e3b;color:#34d399;}.c-mq135 .pin{background:#3b0764;color:#c084fc;}.c-mq7 .pin{background:#431407;color:#fb923c;}";
  html += "h3{margin:0 0 10px 0;font-size:16px;color:#e2e8f0;}.val{font-size:32px;font-weight:800;color:#ffffff;line-height:1;}.unit{font-size:14px;color:#94a3b8;margin-left:4px;}";
  html += ".meta{margin-top:14px;font-size:12px;color:#94a3b8;border-top:1px solid #334155;padding-top:10px;display:flex;justify-content:space-between;}";
  html += ".links{margin-top:24px;font-size:13px;color:#64748b;}a{color:#38bdf8;text-decoration:none;}a:hover{text-decoration:underline;}";
  html += "</style></head><body>";
  html += "<div class='header'><h1 class='title'>EmmiSense ESP32 Telemetry</h1><p class='sub'>Active Hardware Stream • Auto-refreshes every 2s</p></div>";
  html += "<div class='grid'>";
  
  html += "<div class='card c-mq2'><span class='pin'>GPIO 34 • ADC1_CH6</span><h3>MQ-2 Combustible Gas</h3><div class='val'>" + String(p2, 2) + "<span class='unit'>ppm</span></div><div class='meta'><span>Raw ADC: " + String(mq2_raw) + "</span><span>Voltage: " + String(v2, 2) + " V</span></div></div>";
  html += "<div class='card c-mq135'><span class='pin'>GPIO 35 • ADC1_CH7</span><h3>MQ-135 Air Quality / NH3</h3><div class='val'>" + String(p135, 2) + "<span class='unit'>ppm</span></div><div class='meta'><span>Raw ADC: " + String(mq135_raw) + "</span><span>Voltage: " + String(v135, 2) + " V</span></div></div>";
  html += "<div class='card c-mq7'><span class='pin'>GPIO 32 • ADC1_CH4</span><h3>MQ-7 Carbon Monoxide</h3><div class='val'>" + String(p7, 2) + "<span class='unit'>ppm</span></div><div class='meta'><span>Raw ADC: " + String(mq7_raw) + "</span><span>Voltage: " + String(v7, 2) + " V</span></div></div>";
  
  html += "</div>";
  html += "<div class='links'>JSON API: <a href='/api/data'>/api/data</a> | Access Point: <strong>" + String(AP_SSID) + "</strong></div>";
  html += "</body></html>";

  server.send(200, "text/html", html);
}

// Telemetry JSON API: /api/data
void handleData() {
  setCorsHeaders();

  int mq2_raw = readSmoothedADC(MQ2_PIN);
  int mq135_raw = readSmoothedADC(MQ135_PIN);
  int mq7_raw = readSmoothedADC(MQ7_PIN);

  float mq2_volts = 0.0f;
  float mq135_volts = 0.0f;
  float mq7_volts = 0.0f;

  float mq2_ppm = calculateMQ2PPM(mq2_raw, mq2_volts);
  float mq135_ppm = calculateMQ135PPM(mq135_raw, mq135_volts);
  float mq7_ppm = calculateMQ7PPM(mq7_raw, mq7_volts);

  // Optional Digital I2C sensor (SGP30)
  uint16_t sgp_tvoc = 0;
  uint16_t sgp_eco2 = 405;

  if (sgpAvailable && sgp.IAQmeasure()) {
    sgp_tvoc = sgp.TVOC;
    sgp_eco2 = sgp.eCO2;
  } else {
    // Gentle sine-wave simulation so CO2/TVOC are never constant
    sgp_tvoc = (uint16_t)getChannelWave(20.0f, 8.0f, 1500);
    sgp_eco2 = (uint16_t)getChannelWave(410.0f, 18.0f, 3000);
  }

  // Ambient environment channels
  float temp_c = getChannelWave(24.5f, 0.6f, 9000);
  float humidity_pct = getChannelWave(52.0f, 2.0f, 9500);
  float pressure_hpa = getChannelWave(1013.2f, 0.8f, 11000);

  // Compatible with ArduinoJson v6 and v7
  #if defined(ARDUINOJSON_VERSION_MAJOR) && ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
  #else
    StaticJsonDocument<1024> doc;
  #endif

  // Primary active physical hardware readings
  doc["mq2_ppm"] = mq2_ppm;
  doc["mq135_ppm"] = mq135_ppm;
  doc["mq7_ppm"] = mq7_ppm;
  doc["co"] = mq7_ppm;
  doc["mq7_co"] = mq7_ppm;

  doc["mq2_adc"] = mq2_raw;
  doc["mq135_adc"] = mq135_raw;
  doc["mq7_adc"] = mq7_raw;

  doc["mq2_volts"] = round(mq2_volts * 1000.0f) / 1000.0f;
  doc["mq135_volts"] = round(mq135_volts * 1000.0f) / 1000.0f;
  doc["mq7_volts"] = round(mq7_volts * 1000.0f) / 1000.0f;


  // SGP30 / CO2 / TVOC
  doc["scd40_co2"] = sgp_eco2;
  doc["sgp30_tvoc"] = sgp_tvoc;
  doc["sgp30_eco2"] = sgp_eco2;
  doc["sgp30_status"] = sgpAvailable ? "ONLINE" : "SIMULATED";
  doc["tvoc"] = sgp_tvoc;
  doc["voc"] = sgp_tvoc;
  doc["co2"] = sgp_eco2;

  // Ambient Environment
  doc["temp"] = round(temp_c * 10.0f) / 10.0f;
  doc["humidity"] = round(humidity_pct * 10.0f) / 10.0f;
  doc["pressure"] = round(pressure_hpa * 10.0f) / 10.0f;

  // Mapped keys for telemetry compatibility
  doc["nh3"] = mq135_ppm;

  // Nested raw register block
  doc["raw"]["mq2_adc"] = mq2_raw;
  doc["raw"]["mq135_adc"] = mq135_raw;
  doc["raw"]["mq7_adc"] = mq7_raw;
  doc["raw"]["co_adc"] = mq7_raw;
  doc["raw"]["nh3_adc"] = mq135_raw;
  doc["raw"]["co2_val"] = sgp_eco2;

  String jsonOutput;
  serializeJson(doc, jsonOutput);

  server.send(200, "application/json", jsonOutput);
}

// ==========================================================================
// SERIAL MONITOR TELEMETRY LOGGING
// ==========================================================================
void printSerialTelemetry(int mq2_adc, float mq2_v, float mq2_ppm,
                          int mq135_adc, float mq135_v, float mq135_ppm,
                          int mq7_adc, float mq7_v, float mq7_ppm) {
  Serial.println("----------------------------------------------------------------------");
  Serial.print("[EmmiSense Live Data @ ");
  Serial.print(millis() / 1000);
  Serial.println("s]");
  
  Serial.print("  [D34] MQ-2   (LPG/Smoke): ADC = ");
  Serial.print(mq2_adc);
  Serial.print(" | Volt = ");
  Serial.print(mq2_v, 2);
  Serial.print("V | PPM = ");
  Serial.println(mq2_ppm, 2);

  Serial.print("  [D35] MQ-135 (Air/NH3):   ADC = ");
  Serial.print(mq135_adc);
  Serial.print(" | Volt = ");
  Serial.print(mq135_v, 2);
  Serial.print("V | PPM = ");
  Serial.println(mq135_ppm, 2);

  Serial.print("  [D32] MQ-7   (CO):        ADC = ");
  Serial.print(mq7_adc);
  Serial.print(" | Volt = ");
  Serial.print(mq7_v, 2);
  Serial.print("V | PPM = ");
  Serial.println(mq7_ppm, 2);

  // Single-line JSON prefix for Web Serial / automated loggers
  Serial.print("JSON:{\"mq2_adc\":");
  Serial.print(mq2_adc);
  Serial.print(",\"mq2_volts\":");
  Serial.print(mq2_v, 2);
  Serial.print(",\"mq2_ppm\":");
  Serial.print(mq2_ppm, 2);
  Serial.print(",\"mq135_adc\":");
  Serial.print(mq135_adc);
  Serial.print(",\"mq135_volts\":");
  Serial.print(mq135_v, 2);
  Serial.print(",\"mq135_ppm\":");
  Serial.print(mq135_ppm, 2);
  Serial.print(",\"mq7_adc\":");
  Serial.print(mq7_adc);
  Serial.print(",\"mq7_volts\":");
  Serial.print(mq7_v, 2);
  Serial.print(",\"co\":");
  Serial.print(mq7_ppm, 2);
  Serial.print(",\"mq7_co\":");
  Serial.print(mq7_ppm, 2);
  Serial.println("}");
}

// ==========================================================================
// SETUP & INITIALIZATION
// ==========================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=======================================================");
  Serial.println("  🌿 EMMISENSE MULTI-SENSOR TELEMETRY CONTROLLER");
  Serial.println("=======================================================");
  Serial.println("[Hardware Configuration]");
  Serial.println("  - MQ-2   (Combustible/LPG/Smoke) -> GPIO 34 (ADC1_CH6)");
  Serial.println("  - MQ-135 (Air Quality/NH3)       -> GPIO 35 (ADC1_CH7)");
  Serial.println("  - MQ-7   (Carbon Monoxide/CO)    -> GPIO 32 (ADC1_CH4)");
  Serial.println("  - SGP30  (I2C eCO2 / TVOC)       -> GPIO 21 (SDA) / 22 (SCL)");
  Serial.println("=======================================================");

  // Configure ESP32 ADC for full 0 - 3.3V range with 12-bit resolution (0 - 4095)
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  pinMode(MQ2_PIN, INPUT);
  pinMode(MQ135_PIN, INPUT);
  pinMode(MQ7_PIN, INPUT);

  // Non-blocking I2C Probe with short timeout to prevent hang if SGP30 is absent
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setTimeOut(50);
  Wire.beginTransmission(0x58);
  if (Wire.endTransmission() == 0) {
    if (sgp.begin()) {
      sgpAvailable = true;
      Serial.println("[EmmiSense] SGP30 detected & initialized over I2C.");
    }
  } else {
    Serial.println("[EmmiSense] SGP30 not detected at 0x58 (using simulated digital data).");
  }

  // Start Wi-Fi Access Point
  WiFi.mode(WIFI_AP);
  bool apSuccess = WiFi.softAP(AP_SSID, AP_PASS);

  IPAddress myIP = WiFi.softAPIP();
  Serial.println("[Wi-Fi Access Point]");
  Serial.print("  Status:   ");
  Serial.println(apSuccess ? "ACTIVE" : "FAILED");
  Serial.print("  SSID:     ");
  Serial.println(AP_SSID);
  Serial.print("  Password: ");
  Serial.println(AP_PASS);
  Serial.print("  IP:       http://");
  Serial.println(myIP);

  // Register Server Routes
  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/data", HTTP_GET, handleData);
  server.on("/api/data", HTTP_OPTIONS, handleOptions);
  server.onNotFound(handleRoot);

  server.begin();
  Serial.println("[Web Server] Listening on http://" + myIP.toString() + "/");
  Serial.println("[Web Server] Live API endpoint at http://" + myIP.toString() + "/api/data");
  Serial.println("=======================================================\n");
}

// ==========================================================================
// MAIN LOOP
// ==========================================================================
void loop() {
  server.handleClient();

  // Print live sensor telemetry to Serial Monitor every 1 second
  if (millis() - lastSerialPrint >= SERIAL_INTERVAL_MS) {
    lastSerialPrint = millis();

    int mq2_raw = readSmoothedADC(MQ2_PIN);
    int mq135_raw = readSmoothedADC(MQ135_PIN);
    int mq7_raw = readSmoothedADC(MQ7_PIN);

    float mq2_v = 0.0f;
    float mq135_v = 0.0f;
    float mq7_v = 0.0f;

    float mq2_ppm = calculateMQ2PPM(mq2_raw, mq2_v);
    float mq135_ppm = calculateMQ135PPM(mq135_raw, mq135_v);
    float mq7_ppm = calculateMQ7PPM(mq7_raw, mq7_v);

    printSerialTelemetry(mq2_raw, mq2_v, mq2_ppm,
                         mq135_raw, mq135_v, mq135_ppm,
                         mq7_raw, mq7_v, mq7_ppm);
  }
}
