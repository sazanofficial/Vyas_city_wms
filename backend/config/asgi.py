"""Serve Django HTTP and authenticated dashboard WebSockets in one process."""
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

from django.core.asgi import get_asgi_application
django_app = get_asgi_application()

from channels.routing import ProtocolTypeRouter, URLRouter
from django.urls import path
from core.consumers import DashboardConsumer
from core.mqtt_bridge import start_bridge

application = ProtocolTypeRouter({
    "http": django_app,
    "websocket": URLRouter([path("ws", DashboardConsumer.as_asgi())]),
})

# One ASGI worker: MQTT callback and in-memory channel layer share this process.
if os.getenv("MQTT_ENABLED", "true").lower() == "true":
    start_bridge()
