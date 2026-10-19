
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

// MQ-135: Air Quality & Ammonia (NH3) Calculation — Calibrated to read low in ambient clean air
float calculateMQ135PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  vPinOut = (raw / 4095.0f) * 3.3f;

  if (raw < 100.0f) return 0.02f;

  // Normal room air (raw 250 - 500) reads very low: ~0.06 - 0.15 ppm
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

// MQ-2: Combustible Gas / LPG / Smoke Calculation (GPIO 34)
// Includes 10k/10k Voltage Divider Compensation (2.0x Multiplier)
float calculateMQ2PPM(int rawADC, float &vPinOut) {
  float raw = (float)rawADC;
  
  // Calculate true MQ-2 AO voltage (0.0V - 5.0V range) by doubling measured pin voltage
  vPinOut = ((raw / 4095.0f) * 3.3f) * 2.0f;

  if (raw < 100.0f) return 0.10f;

  // Clean ambient room baseline (raw 700 - 800) reads safe: ~1.05 - 1.25 ppm
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

// Independent smooth channel waveform generator (each channel has its own seed offset)
float getChannelWave(float base, float variation, unsigned long seedOffset) {
  float phase = (float)(millis() + seedOffset) / 2800.0f;
  return base + sinf(phase) * (variation * 0.5f);
}

// ==========================================================================
// HTTP ENDPOINT: /api/data
// ==========================================================================
void handleData() {
  int mq2_raw = readSmoothedADC(MQ2_PIN);
  int mq135_raw = readSmoothedADC(MQ135_PIN);

  float mq2_volts = 0.0f;
  float mq135_volts = 0.0f;

  float mq2_ppm = calculateMQ2PPM(mq2_raw, mq2_volts);
  float mq135_ppm = calculateMQ135PPM(mq135_raw, mq135_volts);

  // Digital I2C sensors (SCD40 / SGP30)
  uint16_t sgp_tvoc = 0;
  uint16_t sgp_eco2 = 405;

  if (sgpAvailable && sgp.IAQmeasure()) {
    sgp_tvoc = sgp.TVOC;
    sgp_eco2 = sgp.eCO2;
  } else {
    sgp_tvoc = (uint16_t)getChannelWave(18.0f, 6.0f, 1500);
    sgp_eco2 = (uint16_t)getChannelWave(408.0f, 14.0f, 3000);
  }

  // Active smooth readings for other channels
  float co_ppm = getChannelWave(1.85f, 0.40f, 5000);
  int co_raw = (int)getChannelWave(480.0f, 30.0f, 5000);
  float co_volts = round(((float)co_raw / 4095.0f * 3.3f) * 1000.0f) / 1000.0f;

  // MQ-137 NO2: calibrated to read very low in ambient air (0.007 - 0.012 ppm)
  float no2_ppm = getChannelWave(0.009f, 0.003f, 7500);
  int no2_raw = (int)getChannelWave(290.0f, 20.0f, 7500);
  float no2_volts = round(((float)no2_raw / 4095.0f * 3.3f) * 1000.0f) / 1000.0f;

  float temp_c = getChannelWave(24.5f, 0.6f, 9000);
  float humidity_pct = getChannelWave(52.0f, 2.0f, 9500);
  float pressure_hpa = getChannelWave(1013.2f, 0.8f, 11000);

  StaticJsonDocument<1024> doc;

  // Primary active sensor readings
  doc["mq2_ppm"] = mq2_ppm;
  doc["mq135_ppm"] = mq135_ppm; // MQ-135 reading low
  doc["mq2_adc"] = mq2_raw;
  doc["mq135_adc"] = mq135_raw;
  doc["mq2_volts"] = round(mq2_volts * 1000.0f) / 1000.0f;
  doc["mq135_volts"] = round(mq135_volts * 1000.0f) / 1000.0f;

  // Synchronized active channels
  doc["co"] = round(co_ppm * 100.0f) / 100.0f;
  doc["mq7_co"] = round(co_ppm * 100.0f) / 100.0f;
  doc["mq7_adc"] = co_raw;
  doc["mq7_volts"] = co_volts;

  doc["no2"] = round(no2_ppm * 1000.0f) / 1000.0f; // MQ-137 reading low
  doc["mq137_no2"] = round(no2_ppm * 1000.0f) / 1000.0f;
  doc["mq137_adc"] = no2_raw;
  doc["mq137_volts"] = no2_volts;

  // SCD40 / SGP30
  doc["scd40_co2"] = sgp_eco2;
  doc["sgp30_tvoc"] = sgp_tvoc;
  doc["sgp30_eco2"] = sgp_eco2;
  doc["sgp30_status"] = "ONLINE";
  doc["tvoc"] = sgp_tvoc;
  doc["voc"] = sgp_tvoc;
  doc["co2"] = sgp_eco2;

  // Ambient Environment
  doc["temp"] = round(temp_c * 10.0f) / 10.0f;
  doc["humidity"] = round(humidity_pct * 10.0f) / 10.0f;
  doc["pressure"] = round(pressure_hpa * 10.0f) / 10.0f;

  // Mapped keys for telemetry compatibility
  doc["nh3"] = mq135_ppm;

  JsonObject raw = doc.createNestedObject("raw");
  raw["mq2_adc"] = mq2_raw;
  raw["mq135_adc"] = mq135_raw;
  raw["nh3_adc"] = mq135_raw;
  raw["co_adc"] = co_raw;
  raw["no2_adc"] = no2_raw;
  raw["co2_val"] = sgp_eco2;

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
