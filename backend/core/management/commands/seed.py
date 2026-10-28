"""Initialize the shared schema and seed the first manager and bins."""
import hashlib
import os
import secrets
import sqlite3
from pathlib import Path
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone
from core.models import Bin, User
from core.security import password_hash


class Command(BaseCommand):
    help = "Create the first manager and four bins, preserving existing records"

    def handle(self, *args, **options):
        username = os.getenv("MANAGER_USER", "manager")
        password = os.getenv("MANAGER_PASSWORD", "")
        if len(password) < 12:
            raise CommandError("Set MANAGER_PASSWORD to at least 12 characters")
        database = Path(settings.DATABASES["default"]["NAME"])
        database.parent.mkdir(parents=True, exist_ok=True)
        raw = sqlite3.connect(database)
        raw.executescript((Path(__file__).resolve().parents[4] / "schema.sql").read_text(encoding="utf-8"))
        columns = {row[1] for row in raw.execute("PRAGMA table_info(bins)")}
        if "tole" not in columns:
            raw.execute("ALTER TABLE bins ADD COLUMN tole TEXT NOT NULL DEFAULT ''")
            raw.commit()
        raw.close()
        if not User.objects.filter(username=username).exists():
            User.objects.create(username=username, password_hash=password_hash(password), role="manager", created_at=timezone.now())
            self.stdout.write(f"Created manager: {username}")
        else:
            self.stdout.write(f"Manager {username} already exists; password unchanged")
        for index in range(1, 5):
            bin_id = f"bin{index}"
            if Bin.objects.filter(pk=bin_id).exists():
                continue
            key = secrets.token_hex(24)
            Bin.objects.create(id=bin_id, name=f"Bin {index}", location=f"Location {index}", height_cm=40,
                               threshold=80, sensor_key_hash=hashlib.sha256(key.encode()).hexdigest(), created_at=timezone.now())
            self.stdout.write(f"{bin_id} sensor key: {key}")
        self.stdout.write("Seed complete; existing records preserved.")
