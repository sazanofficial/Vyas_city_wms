from django.urls import path, re_path
from core import views

urlpatterns = [
    path("api/health", views.health),
    path("api/public/content", views.public_content),
    path("api/public/bins", views.public_bins),
    path("api/site-content", views.site_content),
    path("api/login", views.login),
    path("api/me", views.me),
    path("api/bins", views.bins),
    path("api/bins/<str:bin_id>/readings", views.bin_readings),
    path("api/bins/<str:bin_id>", views.bin_detail),
    path("api/users", views.users),
    path("api/users/<int:user_id>", views.user_detail),
    path("api/tasks", views.tasks),
    path("api/tasks/<int:task_id>", views.task_detail),
    path("api/readings/recent", views.recent_readings),
    path("api/reports/summary", views.report),
    re_path(r"^assets/(?P<asset>.+)$", views.asset),
    re_path(r"^(?P<path>.*)$", views.frontend),
]
