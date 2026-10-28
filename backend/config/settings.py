"""Django configuration for the single-process local prototype."""
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
SECRET_KEY = os.getenv("JWT_SECRET", "")
if len(SECRET_KEY) < 32 or SECRET_KEY == "replace-with-a-long-random-secret":
    raise RuntimeError("Set JWT_SECRET to a random string of at least 32 characters")
DEBUG = False
ALLOWED_HOSTS = [value.strip() for value in os.getenv("ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if value.strip()]
INSTALLED_APPS = ["channels", "core"]
MIDDLEWARE = ["django.middleware.security.SecurityMiddleware", "django.middleware.common.CommonMiddleware"]
ROOT_URLCONF = "config.urls"
ASGI_APPLICATION = "config.asgi.application"
db_path = Path(os.getenv("DB_PATH", str(ROOT / "data" / "waste.sqlite")))
if not db_path.is_absolute():
    db_path = ROOT / db_path
DATABASES = {"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": str(db_path), "OPTIONS": {"timeout": 5}}}
CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
USE_TZ = True
TIME_ZONE = "UTC"
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"
STATIC_URL = "/assets/"
