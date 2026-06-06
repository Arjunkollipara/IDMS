import logging
import os
from datetime import date, datetime

import psycopg2
from celery import shared_task

from tasks.escalation import trigger_escalation_workflow

logger = logging.getLogger(__name__)


def _connect():
    """Open a synchronous PostgreSQL connection for Celery work."""
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        dbname=os.getenv("POSTGRES_DB"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )


def _determine_stage(days_until_transfusion):
    """Convert days until transfusion into the escalation stage."""
    if days_until_transfusion <= 3:
        return 3
    if days_until_transfusion <= 5:
        return 2
    if days_until_transfusion <= 7:
        return 1
    return None


def _as_date(value):
    """Normalize a database date or datetime value into a Python date."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return value


def _stage_already_triggered_today(cursor, patient_id, stage, today):
    """Check whether a patient already has a stage trigger logged today."""
    cursor.execute(
        """
        SELECT 1
        FROM escalation_log
        WHERE patient_id = %s
          AND stage = %s
          AND action_taken = 'escalation_triggered'
          AND trigger_date::date = %s
        LIMIT 1
        """,
        (patient_id, stage, today),
    )
    return cursor.fetchone() is not None


@shared_task(name="tasks.daily_scan.run_daily_scan", bind=True, max_retries=3)
def run_daily_scan(self):
    """Scan active patients daily and queue escalation workflows when needed."""
    conn = None
    try:
        conn = _connect()
        conn.autocommit = False
        cursor = conn.cursor()
        today = date.today()

        cursor.execute(
            """
            SELECT patient_id, expected_next_transfusion_date
            FROM patients
            WHERE status = 'active'
              AND expected_next_transfusion_date IS NOT NULL
            ORDER BY expected_next_transfusion_date ASC
            """
        )
        patients = cursor.fetchall()

        summary = {
            "scanned": len(patients),
            "triggered": 0,
            "skipped": 0,
            "by_stage": {"1": 0, "2": 0, "3": 0},
            "scan_time": datetime.utcnow().isoformat(),
        }

        for patient_id, expected_next_transfusion_date in patients:
            if expected_next_transfusion_date is None:
                summary["skipped"] += 1
                continue

            next_transfusion_date = _as_date(expected_next_transfusion_date)
            if next_transfusion_date is None:
                summary["skipped"] += 1
                continue

            days_until = (next_transfusion_date - today).days
            stage = _determine_stage(days_until)
            if stage is None:
                summary["skipped"] += 1
                continue

            if _stage_already_triggered_today(cursor, patient_id, stage, today):
                summary["skipped"] += 1
                continue

            trigger_escalation_workflow.delay(patient_id, stage, days_until)
            summary["triggered"] += 1
            summary["by_stage"][str(stage)] += 1

        cursor.execute(
            """
            INSERT INTO escalation_log (patient_id, trigger_date, stage, action_taken, outcome)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                None,
                datetime.utcnow(),
                None,
                "daily_scan_complete",
                f"triggered {summary['triggered']} patients",
            ),
        )

        conn.commit()
        cursor.close()
        conn.close()
        return summary
    except Exception as exc:
        logger.exception("Daily scan failed")
        if conn is not None:
            conn.rollback()
            conn.close()
        raise self.retry(exc=exc, countdown=60)
