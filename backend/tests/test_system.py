"""Integration checks against a disposable SQLite database."""
import hashlib
import json
import os
import sqlite3
from datetime import timedelta
from pathlib import Path

TEST_DIR = Path(__file__).parent / ".testdata"
TEST_DIR.mkdir(exist_ok=True)
TEST_DB = TEST_DIR / "waste.sqlite"
TEST_DB.unlink(missing_ok=True)
os.environ["DB_PATH"] = str(TEST_DB)
os.environ["ALLOWED_HOSTS"] = "localhost,127.0.0.1,testserver"
os.environ["DJANGO_SETTINGS_MODULE"] = "config.settings"
os.environ["MQTT_ENABLED"] = "false"
os.environ.setdefault("JWT_SECRET", "test-only-secret-longer-than-thirty-two-characters")
import django
django.setup()

from django.test import Client
from django.utils import timezone
from core.models import Bin, CollectionTask, Reading, User
from core.mqtt_bridge import process_message
from core.security import password_hash, token_for
from core.storage import bin_view, cleanup_readings

raw = sqlite3.connect(os.environ["DB_PATH"])
raw.executescript((Path(__file__).resolve().parents[2] / "schema.sql").read_text(encoding="utf-8"))
raw.close()


def test_roles_mqtt_tasks_retention_and_frontend():
    key = "a" * 48
    manager = User.objects.create(username="manager", password_hash=password_hash("manager-password-123"), role="manager", created_at=timezone.now())
    staff = User.objects.create(username="collector", password_hash=password_hash("collector-password-123"), role="staff", created_at=timezone.now())
    bin_record = Bin.objects.create(id="bin1", name="Test bin", location="North gate", height_cm=40, threshold=80,
                                    sensor_key_hash=hashlib.sha256(key.encode()).hexdigest(), created_at=timezone.now())
    client = Client()
    mt, st = token_for(manager), token_for(staff)
    assert client.get("/").status_code == 200
    assert client.get("/api/public/content").json()["municipality_name"] == "व्यास नगरपालिका"
    assert client.get("/api/public/content").json()["department_name"] == "नगर फोहोर व्यवस्थापन विभाग"
    assert client.get("/api/public/bins?tole=North").json()["results"] == []
    assert client.get("/api/public/bins?tole=unknown").json()["results"] == []
    assert client.post("/api/login", data=json.dumps({"username": "manager", "password": "manager-password-123"}), content_type="application/json").status_code == 200
    assert client.get("/api/bins").status_code == 401
    assert client.get("/api/bins", HTTP_AUTHORIZATION=f"Bearer {st}").status_code == 403
    assert client.get("/api/bins/bin1/readings", HTTP_AUTHORIZATION=f"Bearer {st}").status_code == 403
    assert client.get("/api/users", HTTP_AUTHORIZATION=f"Bearer {st}").status_code == 403
    edit = json.dumps({"notice_body": "आजदेखि फोहोर छुट्याएर राख्नुहोस्।"})
    assert client.put("/api/site-content", data=edit, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {st}").status_code == 403
    assert client.put("/api/site-content", data=edit, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {mt}").status_code == 200
    assert client.get("/api/public/content").json()["notice_body"] == "आजदेखि फोहोर छुट्याएर राख्नुहोस्।"
    assert client.put("/api/site-content", data=json.dumps({"invalid_field": "x"}), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {mt}").status_code == 400
    assert client.patch("/api/bins/bin1", data=json.dumps({"tole": "भानु टोल"}), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {mt}").status_code == 200
    assert client.get("/api/public/bins?tole=%E0%A4%AD%E0%A4%BE%E0%A4%A8%E0%A5%81").json()["results"][0]["tole"] == "भानु टोल"
    payload = lambda fill, provided_key=key, item_id="bin1": json.dumps({"bin_id": item_id, "fill_percent": fill, "sensor_key": provided_key}).encode()
    assert process_message("waste/bins/bin99/readings", payload(82, item_id="bin99")) is None
    assert process_message("waste/bins/bin1/readings", payload(82, "b" * 48)) is None
    assert process_message("waste/bins/bin1/readings", payload(101)) is None
    assert process_message("waste/bins/bin1/readings", payload(50))["status"] == "filling"
    assert process_message("waste/bins/bin1/readings", payload(80))["status"] == "filling"
    assert process_message("waste/bins/bin1/readings", payload(82))["status"] == "full"
    assert client.get("/api/bins", HTTP_AUTHORIZATION=f"Bearer {mt}").json()[0]["status"] == "full"
    task_body = json.dumps({"bin_id": "bin1", "staff_id": staff.id, "priority": 3, "note": "Collect today"})
    assert client.post("/api/tasks", data=task_body, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {st}").status_code == 403
    created = client.post("/api/tasks", data=task_body, content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {mt}")
    assert created.status_code == 201
    task_id = created.json()["id"]
    assert len(client.get("/api/tasks", HTTP_AUTHORIZATION=f"Bearer {st}").json()) == 1
    def patch(status):
        return client.patch(f"/api/tasks/{task_id}", data=json.dumps({"status": status}), content_type="application/json", HTTP_AUTHORIZATION=f"Bearer {st}")
    assert patch("completed").status_code == 400
    assert patch("in_progress").status_code == 200
    assert patch("completed").status_code == 200
    assert bin_view(Bin.objects.get(pk="bin1"))["status"] == "emptied"
    assert process_message("waste/bins/bin1/readings", payload(12))["status"] == "normal"
    old = timezone.now() - timedelta(days=2)
    Reading.objects.create(bin=bin_record, fill_percent=10, recorded_at=old)
    Reading.objects.create(bin=bin_record, fill_percent=20, recorded_at=old)
    cleanup_readings()
    rolled = Reading.objects.filter(recorded_at__lt=timezone.now() - timedelta(days=1))
    assert rolled.count() == 1
    assert rolled.first().fill_percent == 15
