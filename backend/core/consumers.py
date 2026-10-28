"""Authenticated dashboard WebSocket endpoint."""
from channels.db import database_sync_to_async
from channels.generic.websocket import AsyncJsonWebsocketConsumer
from .security import user_for_token


class DashboardConsumer(AsyncJsonWebsocketConsumer):
    async def connect(self):
        protocols = self.scope.get("subprotocols", [])
        user = await database_sync_to_async(user_for_token)(protocols[1]) if len(protocols) > 1 and protocols[0] == "waste-v1" else None
        if not user:
            await self.close(code=1008)
            return
        self.user_id = user.id
        self.group = "managers" if user.role == "manager" else f"staff-{user.id}"
        await self.channel_layer.group_add(self.group, self.channel_name)
        await self.accept(subprotocol="waste-v1")
        await self.send_json({"type": "ready", "data": {"user": user.username}})

    async def disconnect(self, close_code):
        if hasattr(self, "group"):
            await self.channel_layer.group_discard(self.group, self.channel_name)

    async def dashboard_message(self, event):
        await self.send_json({"type": event["event"], "data": event["data"]})
