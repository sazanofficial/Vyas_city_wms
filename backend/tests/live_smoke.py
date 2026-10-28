"""Optional live broker -> Django -> React WebSocket check; uses a disposable bin."""
import json
import os
import secrets
import time
from pathlib import Path
from urllib.request import Request, urlopen
from dotenv import load_dotenv
import paho.mqtt.client as mqtt
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
BASE = os.getenv("SMOKE_URL", "http://127.0.0.1:3001")


def api(path, method="GET", payload=None, token=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
                      headers=headers, method=method)
    with urlopen(request, timeout=5) as response:
        return json.load(response) if response.status != 204 else None


def main():
    password = os.getenv("MANAGER_PASSWORD")
    setup = (ROOT / "data" / "setup-credentials.txt").read_text(encoding="utf-8")
    device_password = next(line.split(": ", 1)[1].strip() for line in setup.splitlines() if line.startswith("MQTT device password: "))
    token = api("/api/login", "POST", {"username": os.getenv("MANAGER_USER", "manager"), "password": password})["token"]
    bin_id = "smoke-" + secrets.token_hex(4)
    bin_data = api("/api/bins", "POST", {"id": bin_id, "name": "Disposable smoke test", "location": "Test only", "height_cm": 40, "threshold": 80}, token)
    try:
        ws_url = BASE.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
        with connect(ws_url, subprotocols=["waste-v1", token], open_timeout=5, close_timeout=2) as socket:
            ready = json.loads(socket.recv(timeout=5))
            assert ready["type"] == "ready"
            client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="waste-live-smoke")
            client.username_pw_set("waste-device", device_password)
            client.connect(os.getenv("MQTT_HOST", "127.0.0.1"), int(os.getenv("MQTT_PORT", "1883")), 15)
            client.loop_start()
            try:
                payload = {"bin_id": bin_id, "fill_percent": 37, "sensor_key": bin_data["sensor_key"]}
                result = client.publish(f"waste/bins/{bin_id}/readings", json.dumps(payload), qos=0)
                assert result.rc == mqtt.MQTT_ERR_SUCCESS
                deadline = time.monotonic() + 8
                received = False
                while time.monotonic() < deadline:
                    event = json.loads(socket.recv(timeout=max(deadline - time.monotonic(), 0.1)))
                    if event["type"] == "reading" and event["data"]["id"] == bin_id:
                        received = True
                        break
                assert received, "No live reading event"
                assert api(f"/api/bins/{bin_id}", token=token)["fill_percent"] == 37
                print("Live MQTT -> Django -> WebSocket and SQLite check passed")
            finally:
                client.loop_stop()
                client.disconnect()
    finally:
        api(f"/api/bins/{bin_id}", "DELETE", token=token)


if __name__ == "__main__":
    main()
