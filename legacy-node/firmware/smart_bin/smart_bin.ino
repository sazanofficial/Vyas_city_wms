#include <WiFi.h>
#include <HTTPClient.h>

// Change only BIN_ID and SENSOR_KEY between boards. Use the corresponding key
// printed by npm run seed or returned when a manager creates a bin.
const char* BIN_ID = "bin1";
const char* SENSOR_KEY = "PASTE_THIS_BIN_SENSOR_KEY";
const char* WIFI_SSID = "YOUR_2_4_GHZ_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "http://192.168.1.100:3000/api/data"; // PC LAN IPv4

constexpr uint8_t TRIG_PIN = 5;
constexpr uint8_t ECHO_PIN = 18; // Through 5V-to-3.3V voltage divider, never direct.
constexpr float BIN_HEIGHT_CM = 40.0f;
constexpr unsigned long SEND_INTERVAL_MS = 5000;
constexpr unsigned long WIFI_RETRY_MS = 10000;
unsigned long lastSend = 0;
unsigned long lastWifiAttempt = 0;

int readFillPercent() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (duration == 0) return -1; // No echo: do not report a false empty bin.
  float distanceCm = duration * 0.0343f / 2.0f;
  float raw = (BIN_HEIGHT_CM - distanceCm) * 100.0f / BIN_HEIGHT_CM;
  return constrain(static_cast<int>(roundf(raw)), 0, 100);
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (millis() - lastWifiAttempt < WIFI_RETRY_MS) return;
  lastWifiAttempt = millis();
  Serial.printf("Connecting to 2.4 GHz WiFi %s...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  lastWifiAttempt = millis() - WIFI_RETRY_MS;
  connectWifi();
}

void loop() {
  connectWifi();
  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();
  int fill = readFillPercent();
  if (fill < 0) { Serial.println("Sensor timeout; reading skipped"); return; }
  Serial.printf("%s fill: %d%%, WiFi: %s\n", BIN_ID, fill,
    WiFi.status() == WL_CONNECTED ? "connected" : "disconnected");
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setTimeout(3000);
  if (!http.begin(SERVER_URL)) { Serial.println("Invalid server URL"); return; }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Sensor-Key", SENSOR_KEY);
  String body = String("{\"bin_id\":\"") + BIN_ID + "\",\"fill_percent\":" + String(fill) + "}";
  int code = http.POST(body);
  Serial.printf("HTTP status: %d\n", code);
  if (code > 0) Serial.println(http.getString());
  else Serial.println(http.errorToString(code));
  http.end();
}
