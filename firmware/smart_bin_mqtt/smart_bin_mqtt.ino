#include <WiFi.h>
#include <PubSubClient.h>  // Install "PubSubClient" in Arduino IDE Library Manager.

// The sketch is identical on all four ESP32 boards except BIN_ID and SENSOR_KEY.
const char* BIN_ID = "bin1";
const char* SENSOR_KEY = "PASTE_THIS_BIN_SENSOR_KEY";
const char* WIFI_SSID = "YOUR_2_4_GHZ_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* MQTT_HOST = "192.168.1.100";  // Computer's LAN IPv4, never localhost.
constexpr uint16_t MQTT_PORT = 1883;
const char* MQTT_USER = "waste-device";
const char* MQTT_PASSWORD = "YOUR_BROKER_DEVICE_PASSWORD";

constexpr uint8_t TRIG_PIN = 5;
constexpr uint8_t ECHO_PIN = 18; // 5V ECHO must pass through 1k/2k voltage divider.
constexpr float BIN_HEIGHT_CM = 40.0f;
constexpr unsigned long SEND_INTERVAL_MS = 5000;
constexpr unsigned long RECONNECT_INTERVAL_MS = 10000;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
unsigned long lastSend = 0;
unsigned long lastWifiAttempt = 0;
unsigned long lastMqttAttempt = 0;

int readFillPercent() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  unsigned long duration = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (duration == 0) return -1; // Skip sensor timeout instead of reporting false empty.
  float distanceCm = duration * 0.0343f / 2.0f;
  float raw = (BIN_HEIGHT_CM - distanceCm) * 100.0f / BIN_HEIGHT_CM;
  return constrain(static_cast<int>(roundf(raw)), 0, 100);
}

void reconnect() {
  if (WiFi.status() != WL_CONNECTED) {
    if (millis() - lastWifiAttempt >= RECONNECT_INTERVAL_MS) {
      lastWifiAttempt = millis();
      Serial.printf("Connecting to WiFi %s...\n", WIFI_SSID);
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
    return;
  }
  if (mqtt.connected() || millis() - lastMqttAttempt < RECONNECT_INTERVAL_MS) return;
  lastMqttAttempt = millis();
  String clientId = String("smart-waste-") + BIN_ID;
  bool ok = mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD);
  if (ok) Serial.println("MQTT connected");
  else Serial.printf("MQTT connect failed, state %d\n", mqtt.state());
}

void setup() {
  Serial.begin(115200);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setBufferSize(256);
  mqtt.setKeepAlive(15);
  lastWifiAttempt = millis() - RECONNECT_INTERVAL_MS;
  lastMqttAttempt = millis() - RECONNECT_INTERVAL_MS;
  reconnect();
}

void loop() {
  reconnect();
  if (mqtt.connected()) mqtt.loop(); // Must run often to maintain MQTT connection.
  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();

  int fill = readFillPercent();
  if (fill < 0) { Serial.println("Sensor timeout; reading skipped"); return; }
  Serial.printf("%s fill: %d%% | WiFi: %s | MQTT: %s\n", BIN_ID, fill,
                WiFi.status() == WL_CONNECTED ? "connected" : "disconnected",
                mqtt.connected() ? "connected" : "disconnected");
  if (!mqtt.connected()) return;

  String topic = String("waste/bins/") + BIN_ID + "/readings";
  String payload = String("{\"bin_id\":\"") + BIN_ID + "\",\"fill_percent\":" + String(fill) +
                   ",\"sensor_key\":\"" + SENSOR_KEY + "\"}";
  bool sent = mqtt.publish(topic.c_str(), payload.c_str(), false); // QoS 0, no retained stale reading.
  Serial.printf("MQTT publish %s (%u bytes): %s\n", sent ? "queued" : "failed", payload.length(), topic.c_str());
}
