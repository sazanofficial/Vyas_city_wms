"""Role-protected JSON API and built React files."""
import hashlib
import json
import mimetypes
import re
import secrets
from datetime import timedelta
from pathlib import Path
from django.db import transaction
from django.http import Http404, HttpResponse, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from . import mqtt_bridge
from .events import emit, publish_bins
from .models import Bin, CollectionTask, Reading, User
from .security import authenticated, password_hash, password_ok, token_for
from .site_content import public_content as landing_content, save_content
from .storage import bin_view, bin_views, iso

DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"


def error(message, status=400):
    return JsonResponse({"detail": message}, status=status)


def methods(request, allowed):
    return None if request.method in allowed else error("Method not allowed", 405)


def body_json(request):
    if len(request.body) > 10000:
        return None
    try:
        value = json.loads(request.body)
        return value if isinstance(value, dict) else None
    except (ValueError, UnicodeDecodeError):
        return None


def text(value, maximum):
    return value.strip() if isinstance(value, str) and 0 < len(value.strip()) <= maximum else None


def number(value, minimum, maximum, integral=False):
    if isinstance(value, bool):
        return None
    try:
        result = int(value) if integral else float(value)
        if integral and str(result) != str(value):
            return None
        return result if minimum <= result <= maximum else None
    except (TypeError, ValueError, OverflowError):
        return None


def user_view(user):
    return {"id": user.id, "username": user.username, "role": user.role, "created_at": iso(user.created_at)}


def task_view(task):
    reading = Reading.objects.filter(bin=task.bin).order_by("-recorded_at", "-id").first()
    return {"id": task.id, "bin_id": task.bin_id, "staff_id": task.staff_id, "status": task.status,
            "priority": task.priority, "note": task.note, "created_at": iso(task.created_at),
            "started_at": iso(task.started_at), "completed_at": iso(task.completed_at),
            "bin_name": task.bin.name, "location": task.bin.location, "tole": task.bin.tole, "threshold": task.bin.threshold,
            "staff_name": task.staff.username, "fill_percent": reading.fill_percent if reading else None}


def health(request):
    return JsonResponse({"status": "ok", "mqtt_connected": bool(mqtt_bridge.bridge and mqtt_bridge.bridge.connected)})


def public_content(request):
    if response := methods(request, {"GET"}):
        return response
    return JsonResponse(landing_content())


def public_bins(request):
    if response := methods(request, {"GET"}):
        return response
    query = request.GET.get("tole", "").strip()
    if not query or len(query) > 80:
        return error("Enter a tole name (up to 80 characters)")
    term = query.casefold()
    matches = []
    for bin_record in Bin.objects.order_by("name"):
        if bin_record.tole and term in bin_record.tole.casefold():
            view = bin_view(bin_record)
            matches.append({key: view[key] for key in ("id", "name", "tole", "location", "fill_percent", "status", "last_update")})
        if len(matches) >= 50:
            break
    return JsonResponse({"query": query, "results": matches})


@csrf_exempt
@authenticated(manager=True)
def site_content(request):
    if request.method == "GET":
        return JsonResponse(landing_content())
    if response := methods(request, {"PUT"}):
        return response
    data = body_json(request)
    try:
        saved = save_content(data)
    except ValueError as exc:
        return error(str(exc))
    return JsonResponse(saved)


@csrf_exempt
def login(request):
    if response := methods(request, {"POST"}):
        return response
    data = body_json(request)
    username = text(data.get("username"), 40) if data else None
    password = data.get("password") if data else None
    user = User.objects.filter(username=username).first() if username else None
    if not user or not isinstance(password, str) or not password_ok(password, user.password_hash):
        return error("Invalid username or password", 401)
    return JsonResponse({"token": token_for(user), "user": user_view(user)})


@authenticated()
def me(request):
    return JsonResponse(user_view(request.waste_user))


@csrf_exempt
@authenticated(manager=True)
def bins(request):
    if request.method == "GET":
        return JsonResponse(bin_views(), safe=False)
    if response := methods(request, {"POST"}):
        return response
    data = body_json(request)
    if not data:
        return error("Invalid JSON")
    bin_id = data.get("id")
    name, location = text(data.get("name"), 80), text(data.get("location"), 160)
    tole = data.get("tole", "")
    if not isinstance(tole, str) or len(tole.strip()) > 80:
        return error("Invalid tole name")
    height, threshold = number(data.get("height_cm"), 0.01, 1000), number(data.get("threshold", 80), 1, 100, True)
    if not isinstance(bin_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", bin_id) or not name or not location or height is None or threshold is None:
        return error("Invalid bin details")
    if Bin.objects.filter(pk=bin_id).exists():
        return error("Bin ID already exists", 409)
    key = secrets.token_hex(24)
    bin_record = Bin.objects.create(id=bin_id, name=name, location=location, tole=tole.strip(), height_cm=height, threshold=threshold,
                                    sensor_key_hash=hashlib.sha256(key.encode()).hexdigest(), created_at=timezone.now())
    publish_bins()
    return JsonResponse(bin_view(bin_record) | {"sensor_key": key}, status=201)


@csrf_exempt
@authenticated(manager=True)
def bin_detail(request, bin_id):
    bin_record = Bin.objects.filter(pk=bin_id).first()
    if not bin_record:
        return error("Bin not found", 404)
    if request.method == "GET":
        return JsonResponse(bin_view(bin_record))
    if request.method == "DELETE":
        bin_record.delete()
        publish_bins()
        return HttpResponse(status=204)
    if response := methods(request, {"PATCH"}):
        return response
    data = body_json(request)
    if data is None:
        return error("Invalid JSON")
    for key in ("name", "location", "tole"):
        if key in data:
            value = data[key].strip() if key == "tole" and isinstance(data[key], str) else text(data[key], 80 if key == "name" else 160)
            if value is None or (key != "tole" and not value) or (key == "tole" and len(value) > 80):
                return error("Invalid bin details")
            setattr(bin_record, key, value)
    if "height_cm" in data:
        value = number(data["height_cm"], 0.01, 1000)
        if value is None:
            return error("Invalid bin details")
        bin_record.height_cm = value
    if "threshold" in data:
        value = number(data["threshold"], 1, 100, True)
        if value is None:
            return error("Invalid bin details")
        bin_record.threshold = value
    bin_record.save(update_fields=["name", "location", "tole", "height_cm", "threshold"])
    publish_bins()
    return JsonResponse(bin_view(bin_record))


@authenticated(manager=True)
def bin_readings(request, bin_id):
    if not Bin.objects.filter(pk=bin_id).exists():
        return error("Bin not found", 404)
    limit = number(request.GET.get("limit", 100), 1, 500, True) or 100
    records = Reading.objects.filter(bin_id=bin_id).order_by("-recorded_at", "-id")[:limit]
    return JsonResponse([{"id": row.id, "fill_percent": row.fill_percent, "recorded_at": iso(row.recorded_at)} for row in records], safe=False)


@csrf_exempt
@authenticated(manager=True)
def users(request):
    if request.method == "GET":
        return JsonResponse([user_view(user) for user in User.objects.order_by("id")], safe=False)
    if response := methods(request, {"POST"}):
        return response
    data = body_json(request)
    username = data.get("username") if data else None
    password = data.get("password") if data else None
    if not isinstance(username, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{3,40}", username) or not isinstance(password, str) or not 12 <= len(password) <= 128:
        return error("Invalid username or password")
    if User.objects.filter(username=username).exists():
        return error("Username already exists", 409)
    user = User.objects.create(username=username, password_hash=password_hash(password), role="staff", created_at=timezone.now())
    return JsonResponse(user_view(user), status=201)


@csrf_exempt
@authenticated(manager=True)
def user_detail(request, user_id):
    if response := methods(request, {"DELETE"}):
        return response
    user = User.objects.filter(pk=user_id).first()
    if not user:
        return error("User not found", 404)
    if user.role != "staff":
        return error("Only staff accounts can be removed")
    user.delete()
    emit("tasks", {"removed_staff_id": user_id})
    return HttpResponse(status=204)


@csrf_exempt
@authenticated()
def tasks(request):
    if request.method == "GET":
        records = CollectionTask.objects.select_related("bin", "staff")
        if request.waste_user.role != "manager":
            records = records.filter(staff=request.waste_user)
        records = sorted(records, key=lambda task: (task.status == "completed", -task.priority, -task.created_at.timestamp()))
        return JsonResponse([task_view(task) for task in records], safe=False)
    if response := methods(request, {"POST"}):
        return response
    if request.waste_user.role != "manager":
        return error("Manager access required", 403)
    data = body_json(request)
    if not data:
        return error("Invalid JSON")
    bin_record = Bin.objects.filter(pk=data.get("bin_id")).first() if isinstance(data.get("bin_id"), str) else None
    staff_id = number(data.get("staff_id"), 1, 2**31 - 1, True)
    staff = User.objects.filter(pk=staff_id, role="staff").first() if staff_id else None
    priority = number(data.get("priority", 2), 1, 3, True)
    note = data.get("note", "")
    if not bin_record or not staff or priority is None or not isinstance(note, str) or len(note) > 500:
        return error("Invalid task details")
    task = CollectionTask.objects.create(bin=bin_record, staff=staff, status="pending", priority=priority, note=note.strip(), created_at=timezone.now())
    view = task_view(task)
    emit("task", view, staff.id)
    return JsonResponse(view, status=201)


@csrf_exempt
@authenticated()
def task_detail(request, task_id):
    if response := methods(request, {"PATCH"}):
        return response
    task = CollectionTask.objects.select_related("bin", "staff").filter(pk=task_id).first()
    if not task:
        return error("Task not found", 404)
    if request.waste_user.role == "staff" and task.staff_id != request.waste_user.id:
        return error("Not your task", 403)
    data = body_json(request)
    status = data.get("status") if data else None
    if status not in ("pending", "in_progress", "completed"):
        return error("Invalid status")
    if request.waste_user.role == "staff" and (task.status, status) not in (("pending", "in_progress"), ("in_progress", "completed")):
        return error("Start a pending task, then complete it")
    timestamp = timezone.now()
    with transaction.atomic():
        task.status = status
        task.started_at = None if status == "pending" else task.started_at or timestamp
        task.completed_at = timestamp if status == "completed" else None
        task.save(update_fields=["status", "started_at", "completed_at"])
        if status == "completed":
            task.bin.emptied_at = timestamp
            task.bin.save(update_fields=["emptied_at"])
    view = task_view(task)
    emit("task", view, task.staff_id)
    publish_bins()
    return JsonResponse(view)


@authenticated(manager=True)
def recent_readings(request):
    records = Reading.objects.select_related("bin").order_by("-recorded_at", "-id")[:50]
    return JsonResponse([{"id": row.id, "bin_id": row.bin_id, "bin_name": row.bin.name,
                          "fill_percent": row.fill_percent, "recorded_at": iso(row.recorded_at)} for row in records], safe=False)


@authenticated(manager=True)
def report(request):
    views = bin_views()
    cutoff = timezone.now() - timedelta(days=1)
    counts = {"pending": 0, "in_progress": 0, "completed": 0}
    for status in CollectionTask.objects.values_list("status", flat=True):
        counts[status] = counts.get(status, 0) + 1
    return JsonResponse({"bins": len(views), "full": sum(item["status"] == "full" for item in views),
                         "offline": sum(item["status"] == "offline" for item in views),
                         "readings24h": Reading.objects.filter(recorded_at__gte=cutoff).count(),
                         "tasks": [{"status": key, "count": value} for key, value in counts.items() if value]})


def asset(request, asset):
    target = (DIST / "assets" / asset).resolve()
    if not target.is_relative_to((DIST / "assets").resolve()) or not target.is_file():
        raise Http404()
    return HttpResponse(target.read_bytes(), content_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream")


def frontend(request, path=""):
    if path.startswith("api/") or path == "ws":
        raise Http404()
    target = DIST / "index.html"
    if not target.is_file():
        return error("Build React with npm run build in frontend", 503)
    return HttpResponse(target.read_bytes(), content_type="text/html; charset=utf-8")
