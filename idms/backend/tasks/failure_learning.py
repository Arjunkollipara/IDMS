import logging
import os
from datetime import date, datetime, timedelta

import psycopg2
from celery import shared_task

logger = logging.getLogger(__name__)


def _connect():
    """Open a synchronous PostgreSQL connection for learning updates."""
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        dbname=os.getenv("POSTGRES_DB"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )


def _parse_cycle_date(cycle_date):
    """Convert the Celery cycle date into a Python datetime."""
    if isinstance(cycle_date, datetime):
        return cycle_date
    if isinstance(cycle_date, date):
        return datetime.combine(cycle_date, datetime.min.time())
    if isinstance(cycle_date, str):
        return datetime.fromisoformat(cycle_date)
    raise ValueError("cycle_date must be a datetime, date, or ISO string")


@shared_task(name="tasks.failure_learning.run_failure_learning", bind=True, max_retries=2)
def run_failure_learning(self, patient_id, cycle_date):
    """Summarize one cycle and update donor activity based on recent responses."""
    conn = None
    try:
        conn = _connect()
        conn.autocommit = False
        cursor = conn.cursor()
        cycle_dt = _parse_cycle_date(cycle_date)
        lookback_start = cycle_dt - timedelta(days=90)

        cursor.execute(
            """
            SELECT DISTINCT donor_id
            FROM notifications_log
            WHERE patient_id = %s
              AND sent_at >= %s
              AND donor_id IS NOT NULL
            """,
            (patient_id, cycle_dt),
        )
        contacted_donors = [row[0] for row in cursor.fetchall()]
        donors_contacted = len(contacted_donors)

        cursor.execute(
            """
            SELECT COUNT(DISTINCT donor_id)
            FROM notifications_log
            WHERE patient_id = %s
              AND sent_at >= %s
              AND response IS NOT NULL
              AND TRIM(response) <> ''
              AND donor_id IS NOT NULL
            """,
            (patient_id, cycle_dt),
        )
        donors_responded = int(cursor.fetchone()[0] or 0)

        cursor.execute(
            """
            SELECT COUNT(*)
            FROM reservation_log
            WHERE patient_id = %s
              AND status = 'completed'
              AND reserved_at >= %s
            """,
            (patient_id, cycle_dt),
        )
        donors_donated = int(cursor.fetchone()[0] or 0)

        cursor.execute(
            """
            SELECT COUNT(DISTINCT stage)
            FROM escalation_log
            WHERE patient_id = %s
              AND trigger_date >= %s
              AND stage IS NOT NULL
            """,
            (patient_id, cycle_dt),
        )
        stages_needed = int(cursor.fetchone()[0] or 0)

        pattern_notes = (
            f"Cycle needed {stages_needed} stages. "
            f"{donors_contacted} contacted, "
            f"{donors_responded} responded, "
            f"{donors_donated} donated."
        )

        cursor.execute(
            """
            INSERT INTO learning_log
                (cycle_date, patient_id, stages_needed, donors_contacted, donors_responded, donors_donated, pattern_notes)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            """,
            (
                cycle_dt,
                patient_id,
                stages_needed,
                donors_contacted,
                donors_responded,
                donors_donated,
                pattern_notes,
            ),
        )

        for donor_id in contacted_donors:
            cursor.execute(
                """
                SELECT COUNT(DISTINCT sent_at::date)
                FROM notifications_log
                WHERE donor_id = %s
                  AND sent_at >= %s
                  AND response IS NULL
                """,
                (donor_id, lookback_start),
            )
            no_response_cycles = int(cursor.fetchone()[0] or 0)
            if no_response_cycles >= 3:
                cursor.execute(
                    """
                    UPDATE donors
                    SET user_donation_active_status = 'Inactive',
                        inactive_trigger_comment = 'Very limited activity despite multiple calls'
                    WHERE user_id = %s
                      AND COALESCE(user_donation_active_status, '') <> 'Inactive'
                    """,
                    (donor_id,),
                )

        conn.commit()
        conn.close()
        return {
            "patient_id": patient_id,
            "donors_contacted": donors_contacted,
            "donors_responded": donors_responded,
            "donors_donated": donors_donated,
            "pattern_notes": pattern_notes,
        }
    except Exception as exc:
        logger.exception("Failure learning task failed")
        if conn is not None:
            conn.rollback()
            conn.close()
        raise self.retry(exc=exc, countdown=60)
