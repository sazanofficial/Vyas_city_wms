"""Send role-scoped live events through the local Channels layer."""
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer
from .storage import bin_views


def emit(event_type, data, staff_id=None, include_manager=True):
    layer = get_channel_layer()
    message = {"type": "dashboard.message", "event": event_type, "data": data}
    if include_manager:
        async_to_sync(layer.group_send)("managers", message)
    if staff_id is not None:
        async_to_sync(layer.group_send)(f"staff-{staff_id}", message)


def publish_bins():
    views = bin_views()
    emit("bins", views)
    emit("alerts", [item for item in views if item["status"] in ("full", "offline")])
