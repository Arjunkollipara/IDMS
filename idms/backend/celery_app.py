from celery import Celery
import os


app = Celery(
    "idms",
    broker=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    backend=os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    include=[
        "tasks.daily_scan",
        "tasks.escalation",
        "tasks.failure_learning",
    ],
)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="Asia/Kolkata",
    enable_utc=True,
    beat_schedule={
        "daily-transfusion-scan": {
            "task": "tasks.daily_scan.run_daily_scan",
            "schedule": 86400.0,
        }
    },
)
