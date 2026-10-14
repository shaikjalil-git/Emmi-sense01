#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_SGP30.h>

// ==========================================================================
// HARDWARE PIN MAPPING
// Active Analog Sensors (ADC1):
// - MQ-2  (Combustible Gas / LPG / Smoke) on GPIO 34 (via 10k/10k Voltage Divider)
// - MQ-135 (Air Quality / NH3 / Ammonia) on GPIO 35
// Active Digital I2C Sensor:
// - SGP30 (TVOC / eCO2) on GPIO 21 (SDA) & GPIO 22 (SCL)
// ==========================================================================
#define MQ2_PIN   34
#define MQ135_PIN 35
#define I2C_SDA   21
#define I2C_SCL   22

// Wi-Fi Access Point Configuration
const char* AP_SSID = "EmmiSense_AP";
const char* AP_PASS = "12345678";

WebServer server(80);
Adafruit_SGP30 sgp;
bool sgpAvailable = false;

// Multi-sample 16x smoothed ADC read
int readSmoothedADC(int pin) {
  long sum = 0;
  for (int i = 0; i < 16; i++) {
    sum += analogRead(pin);
    delay(2);
  }
  return (int)(sum / 16);
}

// ==========================================================================
// MQ-135 CALIBRATION & PPM CALCULATION
// ==========================================================================
float calculateMQ135PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  vPinOut = (raw / 4095.0f) * 3.3f;

  if (raw < 150.0f) return 0.0f;

  float ppm = 0.30f;
  if (raw <= 2000.0f) {
    ppm = 0.30f + ((raw - 150.0f) / 1850.0f) * 2.20f;
  } else if (raw <= 3400.0f) {
    ppm = 2.50f + ((raw - 2000.0f) / 1400.0f) * 15.50f;
  } else {
    ppm = 18.00f + ((raw - 3400.0f) / 695.0f) * 27.00f;
  }

  return round(ppm * 100.0f) / 100.0f;
}

// ==========================================================================
// MQ-2 LOGARITHMIC SENSOR RESISTANCE (Rs/R0) SCALING WITH VOLTAGE DIVIDER
// ==========================================================================
float calculateMQ2PPM(int rawADC, float &vSensorOut, bool &isSaturatedOut) {
  // 1. ADC Bounds & Saturation Detection
  isSaturatedOut = (rawADC >= 4095);
  if (rawADC < 150) {
    vSensorOut = 0.0f;
    return 0.0f; // Disconnected or pulled low
  }

  // 2. Measure pin voltage (ESP32 ADC 0 - 3.3V)
  float raw = (float)rawADC;
  float v_pin = (raw / 4095.0f) * 3.3f;
  if (v_pin > 3.3f) v_pin = 3.3f;

  // 3. Compensate for 10k/10k hardware voltage divider (2.0x Multiplier)
  // Clamp actual sensor voltage to max 5.0V
  float v_sensor = v_pin * 2.0f;
  if (v_sensor > 5.0f) v_sensor = 5.0f;
  vSensorOut = v_sensor;

  // 4. Clamping for Rs calculation to prevent division-by-zero / NaN math explosions
  float v_calc = v_sensor;
  if (v_calc > 4.85f) v_calc = 4.85f; // Ensures (5.0 - v_calc) >= 0.15V
  if (v_calc < 0.10f) v_calc = 0.10f;

  // 5. Sensor Resistance Rs = ((Vcc - Vout) * RL) / Vout (RL = 10.0 kOhm)
  float Rs = ((5.0f - v_calc) * 10.0f) / v_calc;

  // 6. Typical clean air baseline R0 for MQ-2 (~10.0 kOhm)
  const float R0 = 10.0f;
  float ratio = Rs / R0;
  if (ratio < 0.01f) ratio = 0.01f;

  // 7. Standard MQ-2 Logarithmic Power-Law Curve for LPG / Smoke:
  // PPM = a * (Rs / R0)^b where a = 574.25, b = -2.222
  float ppm = 574.25f * pow(ratio, -2.222f);

  // 8. Apply realistic bounds
  if (ppm < 0.1f) ppm = 0.1f;
  if (ppm > 1000.0f) ppm = 1000.0f; // Sensor measurement ceiling

  return round(ppm * 100.0f) / 100.0f;
}

// ==========================================================================
// HTTP ENDPOINT: /api/data
// ==========================================================================
void handleData() {
  int mq2_raw = readSmoothedADC(MQ2_PIN);
  int mq135_raw = readSmoothedADC(MQ135_PIN);

  float mq2_volts = 0.0f;
  float mq135_volts = 0.0f;
  bool mq2_saturated = false;

  float mq2_ppm = calculateMQ2PPM(mq2_raw, mq2_volts, mq2_saturated);
  float mq135_ppm = calculateMQ135PPM(mq135_raw, mq135_volts);

  uint16_t sgp_tvoc = 0;
  uint16_t sgp_eco2 = 400;

  if (sgpAvailable && sgp.IAQmeasure()) {
    sgp_tvoc = sgp.TVOC;
    sgp_eco2 = sgp.eCO2;
  }

  StaticJsonDocument<512> doc;

  // Primary sensor readings
  doc["mq2_ppm"] = mq2_ppm;
  doc["mq135_ppm"] = mq135_ppm;
  doc["mq2_adc"] = mq2_raw;
  doc["mq135_adc"] = mq135_raw;
  doc["mq2_volts"] = round(mq2_volts * 1000.0f) / 1000.0f;
  doc["mq135_volts"] = round(mq135_volts * 1000.0f) / 1000.0f;
  doc["mq2_saturated"] = mq2_saturated;

  // SGP30 Active Digital Readings
  doc["sgp30_tvoc"] = sgp_tvoc;
  doc["sgp30_eco2"] = sgp_eco2;
  doc["sgp30_status"] = sgpAvailable ? "ONLINE" : "OFFLINE";

  // Mapped keys for telemetry compatibility
  doc["nh3"] = mq135_ppm;
  doc["voc"] = sgp_tvoc;
  doc["co2"] = sgp_eco2;
  doc["co"] = 0.0;    // Inactive
  doc["no2"] = 0.0;   // Inactive

  JsonObject raw = doc.createNestedObject("raw");
  raw["mq2_adc"] = mq2_raw;
  raw["mq135_adc"] = mq135_raw;
  raw["nh3_adc"] = mq135_raw;
  raw["co_adc"] = 0;
  raw["no2_adc"] = 0;

  String jsonOutput;
  serializeJson(doc, jsonOutput);

  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(200, "application/json", jsonOutput);
}

void handleOptions() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "*");
  server.send(204);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[EmmiSense] Initializing Sensors (MQ-2 on GPIO 34, MQ-135 on GPIO 35, SGP30 on I2C GPIO 21/22)...");

  pinMode(MQ2_PIN, INPUT);
  pinMode(MQ135_PIN, INPUT);

  Wire.begin(I2C_SDA, I2C_SCL);
  if (sgp.begin()) {
    sgpAvailable = true;
    Serial.println("[EmmiSense] SGP30 initialized successfully over I2C.");
  } else {
    Serial.println("[EmmiSense] WARNING: SGP30 sensor not detected on I2C bus!");
  }

  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASS);

  IPAddress myIP = WiFi.softAPIP();
  Serial.print("[EmmiSense] AP active at IP: ");
  Serial.println(myIP);

  server.on("/api/data", HTTP_GET, handleData);
  server.on("/api/data", HTTP_OPTIONS, handleOptions);

  server.begin();
  Serial.println("[EmmiSense] HTTP server listening on /api/data");
}

void loop() {
  server.handleClient();
}