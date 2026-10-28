"""Presentation views and reading retention."""
from datetime import timedelta
from django.db import connection, transaction
from django.utils import timezone
from .models import Bin, Reading


def iso(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z") if value else None


def bin_view(bin_record):
    latest = Reading.objects.filter(bin=bin_record).order_by("-recorded_at", "-id").first()
    last = latest.recorded_at if latest else None
    offline = last is None or timezone.now() - last > timedelta(seconds=30)
    awaiting = bool(bin_record.emptied_at and last and bin_record.emptied_at >= last)
    fill = latest.fill_percent if latest else None
    status = "offline" if offline else "emptied" if awaiting else "full" if fill > bin_record.threshold else "filling" if fill >= 50 else "normal"
    return {"id": bin_record.id, "name": bin_record.name, "location": bin_record.location, "tole": bin_record.tole,
            "height_cm": bin_record.height_cm, "threshold": bin_record.threshold,
            "fill_percent": fill, "last_update": iso(last), "status": status,
            "emptied_at": iso(bin_record.emptied_at), "awaiting_reading": awaiting}


def bin_views():
    return [bin_view(record) for record in Bin.objects.order_by("id")]


def cleanup_readings():
    with transaction.atomic(), connection.cursor() as cursor:
        cursor.execute("CREATE TEMP TABLE IF NOT EXISTS reading_rollup (bin_id TEXT, bucket TEXT, fill_percent INTEGER)")
        cursor.execute("DELETE FROM reading_rollup")
        cursor.execute("""INSERT INTO reading_rollup
            SELECT bin_id,strftime('%Y-%m-%dT%H:00:00Z',recorded_at),ROUND(AVG(fill_percent))
            FROM readings WHERE strftime('%s',recorded_at) < strftime('%s','now','-1 day')
              AND strftime('%s',recorded_at) >= strftime('%s','now','-30 days')
            GROUP BY bin_id,strftime('%Y-%m-%dT%H:00:00Z',recorded_at)""")
        cursor.execute("DELETE FROM readings WHERE strftime('%s',recorded_at) < strftime('%s','now','-1 day')")
        cursor.execute("INSERT INTO readings (bin_id,fill_percent,recorded_at) SELECT bin_id,fill_percent,bucket FROM reading_rollup")
