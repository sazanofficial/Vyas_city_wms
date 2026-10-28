"""Models mapped to the existing SQLite schema from the Node prototype."""
from django.db import models


class User(models.Model):
    username = models.TextField(unique=True)
    password_hash = models.TextField()
    role = models.TextField()
    created_at = models.DateTimeField()

    class Meta:
        db_table = "users"
        managed = False


class Bin(models.Model):
    id = models.TextField(primary_key=True)
    name = models.TextField()
    location = models.TextField()
    tole = models.TextField(default="")
    height_cm = models.FloatField()
    threshold = models.IntegerField()
    sensor_key_hash = models.TextField()
    emptied_at = models.DateTimeField(null=True)
    created_at = models.DateTimeField()

    class Meta:
        db_table = "bins"
        managed = False


class Reading(models.Model):
    bin = models.ForeignKey(Bin, on_delete=models.CASCADE, db_column="bin_id")
    fill_percent = models.IntegerField()
    recorded_at = models.DateTimeField()

    class Meta:
        db_table = "readings"
        managed = False


class CollectionTask(models.Model):
    bin = models.ForeignKey(Bin, on_delete=models.CASCADE, db_column="bin_id")
    staff = models.ForeignKey(User, on_delete=models.CASCADE, db_column="staff_id")
    status = models.TextField()
    priority = models.IntegerField()
    note = models.TextField()
    created_at = models.DateTimeField()
    started_at = models.DateTimeField(null=True)
    completed_at = models.DateTimeField(null=True)

    class Meta:
        db_table = "collection_tasks"
        managed = False


class SiteContent(models.Model):
    key = models.TextField(primary_key=True)
    value = models.TextField()
    updated_at = models.DateTimeField()

    class Meta:
        db_table = "site_content"
        managed = False
