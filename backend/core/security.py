"""Bcrypt and JWT authorization for HTTP and WebSocket clients."""
from datetime import datetime, timedelta, timezone
from functools import wraps
import bcrypt
import jwt
from django.conf import settings
from django.http import JsonResponse
from .models import User


def password_hash(password):
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode()


def password_ok(password, encoded):
    try:
        return bcrypt.checkpw(password.encode(), encoded.encode())
    except (TypeError, ValueError):
        return False


def token_for(user):
    return jwt.encode({"sub": str(user.id), "exp": datetime.now(timezone.utc) + timedelta(hours=8)}, settings.SECRET_KEY, algorithm="HS256")


def user_for_token(token):
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
        return User.objects.filter(pk=payload["sub"]).first()
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def authenticated(manager=False):
    def decorator(view):
        @wraps(view)
        def wrapped(request, *args, **kwargs):
            header = request.headers.get("Authorization", "")
            user = user_for_token(header[7:]) if header.startswith("Bearer ") else None
            if user is None:
                return JsonResponse({"detail": "Authentication required"}, status=401)
            if manager and user.role != "manager":
                return JsonResponse({"detail": "Manager access required"}, status=403)
            request.waste_user = user
            return view(request, *args, **kwargs)
        return wrapped
    return decorator
