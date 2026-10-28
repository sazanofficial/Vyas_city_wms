"""MQTT broker subscriber for four ESP32 bin sensors."""
import hashlib
import hmac
import json
import logging
import os
import re
import threading
import time
import paho.mqtt.client as mqtt
from django.db import close_old_connections
from django.utils import timezone
from .events import emit, publish_bins
from .models import Bin, CollectionTask, Reading
from .storage import bin_view, cleanup_readings

log = logging.getLogger(__name__)
TOPIC = "waste/bins/+/readings"
TOPIC_RE = re.compile(r"^waste/bins/([A-Za-z0-9_-]{1,32})/readings$")
bridge = None


def process_message(topic: str, payload: bytes):
    """Validate topic, registered bin, key and fill before storing a reading."""
    match = TOPIC_RE.fullmatch(topic)
    if not match or len(payload) > 1024:
        return None
    try:
        item = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(item, dict) or item.get("bin_id") != match.group(1):
        return None
    fill = item.get("fill_percent")
    key = item.get("sensor_key")
    if type(fill) is not int or not 0 <= fill <= 100 or not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{48}", key):
        return None
    close_old_connections()
    bin_record = Bin.objects.filter(pk=match.group(1)).first()
    if not bin_record or not hmac.compare_digest(hashlib.sha256(key.encode()).hexdigest(), bin_record.sensor_key_hash):
        return None
    Reading.objects.create(bin=bin_record, fill_percent=fill, recorded_at=timezone.now())
    view = bin_view(bin_record)
    emit("reading", view)
    for staff_id in CollectionTask.objects.filter(bin=bin_record, status__in=("pending", "in_progress")).values_list("staff_id", flat=True).distinct():
        emit("reading", {"id": bin_record.id}, staff_id=staff_id, include_manager=False)
    publish_bins()
    close_old_connections()
    return view


class MQTTBridge:
    def __init__(self):
        self.connected = False
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="waste-django-backend")
        username = os.getenv("MQTT_USER", "")
        if username:
            self.client.username_pw_set(username, os.getenv("MQTT_PASSWORD", ""))
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = self.on_disconnect
        self.client.on_message = self.on_message
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)

    def start(self):
        self.client.connect_async(os.getenv("MQTT_HOST", "127.0.0.1"), int(os.getenv("MQTT_PORT", "1883")), keepalive=30)
        self.client.loop_start()
        threading.Thread(target=self.periodic, daemon=True, name="waste-periodic").start()

    def on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = not reason_code.is_failure
        if self.connected:
            client.subscribe(TOPIC, qos=0)
            log.info("MQTT connected, subscribed to %s", TOPIC)
        else:
            log.warning("MQTT connect rejected: %s", reason_code)

    def on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        self.connected = False
        log.warning("MQTT disconnected: %s", reason_code)

    def on_message(self, client, userdata, message):
        if process_message(message.topic, message.payload) is None:
            log.warning("Rejected reading on %s", message.topic)

    def periodic(self):
        next_cleanup = 0
        while True:
            time.sleep(5)
            try:
                close_old_connections()
                publish_bins()
                if time.monotonic() >= next_cleanup:
                    cleanup_readings()
                    next_cleanup = time.monotonic() + 3600
                close_old_connections()
            except Exception:
                log.exception("Periodic dashboard refresh failed")


def start_bridge():
    global bridge
    if bridge is None:
        bridge = MQTTBridge()
        bridge.start()
