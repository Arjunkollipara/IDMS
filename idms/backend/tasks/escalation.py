import logging
import os
from datetime import date, datetime

import psycopg2
from celery import shared_task

logger = logging.getLogger(__name__)


def _connect():
    """Open a synchronous PostgreSQL connection for escalation work."""
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST"),
        port=os.getenv("POSTGRES_PORT", "5432"),
        dbname=os.getenv("POSTGRES_DB"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )


def _to_date(value):
    """Convert PostgreSQL date and datetime values into a Python date."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return value


def _build_outreach_message(stage, count, blood_group):
    """Build the stage-specific outreach template without calling Azure."""
    if stage == 1:
        return (
            f"Hi there, this is Priya from Blood Warriors. "
            f"You have helped our patient {count} times before - thank you! "
            f"They need blood ({blood_group}) in about a week. "
            "Are you available to help again?"
        )
    if stage == 2:
        return (
            f"Hi, Priya here from Blood Warriors. Our patient urgently needs "
            f"{blood_group} blood in 5 days. You have donated {count} times before. "
            "Can you help? Please reply YES or NO."
        )
    return (
        f"URGENT: Blood Warriors patient needs {blood_group} blood in 3 days. "
        "As a thank you, donors this week receive a food voucher from our partners. "
        "Can you help? Reply YES to confirm."
    )


def _build_sonar_message(city_name):
    """Build the standard sonar ping message for a location check."""
    return (
        f"Hi, Priya from Blood Warriors here. Are you currently in {city_name}? "
        "We may need your help soon. Reply YES or NO."
    )


def _stage_already_triggered_today(cursor, patient_id, stage, today):
    """Check whether this patient has already been triggered for the stage today."""
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


def _log_notification(cursor, donor_id, patient_id, message, notification_type):
    """Insert a notification and return the created identifier."""
    cursor.execute(
        """
        INSERT INTO notifications_log
            (donor_id, patient_id, message, sent_at, channel, notification_type)
        VALUES (%s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            donor_id,
            patient_id,
            message,
            datetime.utcnow(),
            "whatsapp_sim",
            notification_type,
        ),
    )
    return cursor.fetchone()[0]


def _get_patient(cursor, patient_id):
    """Fetch one patient record from PostgreSQL."""
    cursor.execute(
        """
        SELECT patient_id, blood_group, latitude, longitude, expected_next_transfusion_date
        FROM patients
        WHERE patient_id = %s
        """,
        (patient_id,),
    )
    return cursor.fetchone()


def _get_donor_pool(cursor, patient_id, stage, patient_blood_group):
    """Fetch the donor pool for the given patient and escalation stage."""
    cursor.execute(
        """
        SELECT DISTINCT donor_id
        FROM escalation_pool
        WHERE patient_id = %s
          AND pool_stage <= %s
          AND donor_id IS NOT NULL
        ORDER BY donor_id
        """,
        (patient_id, stage),
    )
    donor_ids = [row[0] for row in cursor.fetchall()]

    if stage == 2 and not donor_ids:
        cursor.execute(
            """
            SELECT user_id
            FROM donors
            WHERE blood_group = %s
              AND donor_category = 'Emergency Donor'
              AND user_donation_active_status = 'Active'
            ORDER BY user_id
            """,
            (patient_blood_group,),
        )
        donor_ids = [row[0] for row in cursor.fetchall()]

    return donor_ids


def _filter_eligible_donors(cursor, donor_ids):
    """Reduce donor IDs to the subset that is currently eligible."""
    if not donor_ids:
        return []

    cursor.execute(
        """
        SELECT user_id
        FROM donors
        WHERE user_id = ANY(%s)
          AND (next_eligible_date IS NULL OR next_eligible_date <= %s)
          AND COALESCE(eligibility_status, '') <> 'not eligible'
          AND user_donation_active_status = 'Active'
        ORDER BY normalized_reliability_score DESC NULLS LAST, user_id
        """,
        (donor_ids, datetime.utcnow()),
    )
    return [row[0] for row in cursor.fetchall()]


@shared_task(name="tasks.escalation.trigger_escalation_workflow", bind=True, max_retries=3)
def trigger_escalation_workflow(self, patient_id, stage, days_until):
    """Run the full escalation workflow for one patient at one stage."""
    conn = None
    try:
        conn = _connect()
        conn.autocommit = False
        cursor = conn.cursor()
        today = date.today()

        if _stage_already_triggered_today(cursor, patient_id, stage, today):
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM notifications_log
                WHERE patient_id = %s
                  AND notification_type IN ('outreach', 'sonar_ping')
                  AND sent_at::date = %s
                """,
                (patient_id, today),
            )
            donors_contacted = int(cursor.fetchone()[0] or 0)
            conn.close()
            return {
                "patient_id": patient_id,
                "stage": stage,
                "donors_contacted": donors_contacted,
                "messages_queued": 0,
                "status": "already_triggered",
            }

        patient = _get_patient(cursor, patient_id)
        if patient is None:
            conn.close()
            return {
                "patient_id": patient_id,
                "stage": stage,
                "donors_contacted": 0,
                "messages_queued": 0,
                "status": "patient_not_found",
            }

        patient_blood_group = patient[1]
        city_name = "the city"
        donor_ids = _get_donor_pool(cursor, patient_id, stage, patient_blood_group)
        eligible_donor_ids = _filter_eligible_donors(cursor, donor_ids)
        top_donor_ids = eligible_donor_ids[:10]

        messages_queued = 0
        for donor_id in top_donor_ids:
            generate_outreach_task.delay(donor_id, patient_id, stage)
            messages_queued += 1

        if eligible_donor_ids:
            send_sonar_task.delay(patient_id, eligible_donor_ids, city_name)

        cursor.execute(
            """
            INSERT INTO escalation_log
                (patient_id, bridge_id, trigger_date, stage, action_taken, outcome)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (
                patient_id,
                None,
                datetime.utcnow(),
                stage,
                "escalation_triggered",
                "pending",
            ),
        )

        conn.commit()
        conn.close()
        return {
            "patient_id": patient_id,
            "stage": stage,
            "donors_contacted": len(eligible_donor_ids),
            "messages_queued": messages_queued,
        }
    except Exception as exc:
        logger.exception("Escalation workflow failed")
        if conn is not None:
            conn.rollback()
            conn.close()
        raise self.retry(exc=exc, countdown=60)


@shared_task(name="tasks.escalation.generate_outreach_task", bind=True, max_retries=2)
def generate_outreach_task(self, donor_id, patient_id, stage):
    """Generate and log one outreach message for one donor-patient pair."""
    conn = None
    try:
        conn = _connect()
        conn.autocommit = False
        cursor = conn.cursor()
        today = date.today()

        cursor.execute(
            """
            SELECT d.user_id, d.blood_group, d.donor_category, b.donations_till_date, b.bridge_blood_group
            FROM donors d
            LEFT JOIN bridges b
              ON b.donor_id = d.user_id AND b.patient_id = %s
            WHERE d.user_id = %s
            LIMIT 1
            """,
            (patient_id, donor_id),
        )
        donor_row = cursor.fetchone()

        if donor_row is None:
            conn.close()
            return {
                "donor_id": donor_id,
                "patient_id": patient_id,
                "message": "",
                "notification_id": None,
                "status": "donor_not_found",
            }

        cursor.execute(
            """
            SELECT blood_group
            FROM patients
            WHERE patient_id = %s
            """,
            (patient_id,),
        )
        patient_row = cursor.fetchone()

        donations_till_date = donor_row[3] or 0
        blood_group = donor_row[4] or (patient_row[0] if patient_row else "blood")
        message = _build_outreach_message(stage, donations_till_date, blood_group)

        cursor.execute(
            """
            SELECT id
            FROM notifications_log
            WHERE donor_id = %s
              AND patient_id = %s
              AND notification_type = 'outreach'
              AND sent_at::date = %s
              AND message = %s
            ORDER BY id DESC
            LIMIT 1
            """,
            (donor_id, patient_id, today, message),
        )
        existing = cursor.fetchone()
        if existing is not None:
            conn.close()
            return {
                "donor_id": donor_id,
                "patient_id": patient_id,
                "message": message,
                "notification_id": existing[0],
                "status": "already_logged",
            }

        notification_id = _log_notification(cursor, donor_id, patient_id, message, "outreach")
        conn.commit()
        conn.close()
        return {
            "donor_id": donor_id,
            "patient_id": patient_id,
            "message": message,
            "notification_id": notification_id,
        }
    except Exception as exc:
        logger.exception("Outreach generation failed")
        if conn is not None:
            conn.rollback()
            conn.close()
        raise self.retry(exc=exc, countdown=60)


@shared_task(name="tasks.escalation.send_sonar_task", bind=True, max_retries=2)
def send_sonar_task(self, patient_id, donor_ids, city_name):
    """Send location check pings to the specified donors for one patient."""
    conn = None
    try:
        conn = _connect()
        conn.autocommit = False
        cursor = conn.cursor()
        today = date.today()
        message = _build_sonar_message(city_name)
        pings_sent = 0

        for donor_id in donor_ids or []:
            cursor.execute(
                """
                SELECT id
                FROM notifications_log
                WHERE donor_id = %s
                  AND patient_id = %s
                  AND notification_type = 'sonar_ping'
                  AND sent_at::date = %s
                  AND message = %s
                ORDER BY id DESC
                LIMIT 1
                """,
                (donor_id, patient_id, today, message),
            )
            existing = cursor.fetchone()
            if existing is not None:
                continue

            _log_notification(cursor, donor_id, patient_id, message, "sonar_ping")
            pings_sent += 1

        conn.commit()
        conn.close()
        return {"pings_sent": pings_sent, "patient_id": patient_id}
    except Exception as exc:
        logger.exception("Sonar task failed")
        if conn is not None:
            conn.rollback()
            conn.close()
        raise self.retry(exc=exc, countdown=60)
