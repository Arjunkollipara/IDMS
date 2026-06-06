from datetime import date, datetime
from typing import Any, Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import func, select

from database import get_async_session
from eligibility import get_eligible_donors
from models import Donor, EscalationLog, EscalationPool, Patient
from ranking import rank_donors


scheduler = AsyncIOScheduler()


def _determine_stage(days_until: int) -> Optional[int]:
    if days_until <= 3:
        return 3
    if days_until <= 5:
        return 2
    if days_until <= 7:
        return 1
    return None


def _color_hint(days_until: int) -> str:
    if days_until <= 3:
        return "red"
    if days_until <= 5:
        return "yellow"
    if days_until <= 7:
        return "green"
    return "none"


async def _get_pool_donor_ids(patient: Patient, stage: int, session: Any) -> List[str]:
    query = select(EscalationPool).where(
        EscalationPool.patient_id == patient.patient_id,
        EscalationPool.pool_stage <= stage,
    )
    result = await session.execute(query)
    pool_entries = result.scalars().all()
    donor_ids = [entry.donor_id for entry in pool_entries if entry.donor_id]

    if stage == 2 and not donor_ids:
        fallback_query = select(Donor).where(
            Donor.blood_group == patient.blood_group,
            Donor.donor_category == "Emergency Donor",
            Donor.user_donation_active_status == "Active",
        )
        fallback_result = await session.execute(fallback_query)
        donor_ids = [donor.user_id for donor in fallback_result.scalars().all() if donor.user_id]

    return donor_ids


async def run_scheduler_scan() -> Dict[str, Any]:
    """Run a full escalation scan and schedule donors for patients approaching transfusion."""
    summary = {
        "patients_scanned": 0,
        "patients_triggered": 0,
        "by_stage": {"1": 0, "2": 0, "3": 0},
        "triggered_patients": [],
    }
    today = date.today()

    async with get_async_session() as session:
        patient_result = await session.execute(select(Patient).where(Patient.status == "active"))
        patients = patient_result.scalars().all()
        summary["patients_scanned"] = len(patients)

        for patient in patients:
            if not patient.expected_next_transfusion_date:
                continue

            days_until = max(0, (patient.expected_next_transfusion_date.date() - today).days)
            stage = _determine_stage(days_until)
            if stage is None:
                continue

            log_query = select(EscalationLog).where(
                EscalationLog.patient_id == patient.patient_id,
                EscalationLog.stage == stage,
                func.date(EscalationLog.trigger_date) == today,
            )
            log_result = await session.execute(log_query)
            existing_log = log_result.scalars().first()
            if existing_log:
                continue

            donor_ids = await _get_pool_donor_ids(patient, stage, session)
            if not donor_ids:
                continue

            eligible_donors, _ = await get_eligible_donors(patient.patient_id, today, session=session)
            eligible_ids = [d["donor_id"] for d in eligible_donors if d["donor_id"] in donor_ids]
            ranked = await rank_donors(patient.patient_id, eligible_ids, session=session)

            escalation_record = EscalationLog(
                patient_id=patient.patient_id,
                trigger_date=datetime.utcnow(),
                stage=stage,
                action_taken="auto_scheduled",
                outcome="pending",
            )
            session.add(escalation_record)
            await session.commit()

            summary["patients_triggered"] += 1
            summary["by_stage"][str(stage)] += 1
            summary["triggered_patients"].append(
                {
                    "patient_id": patient.patient_id,
                    "stage": stage,
                    "days_until_transfusion": days_until,
                    "eligible_donors": len(ranked),
                    "top_donors": ranked[:5],
                }
            )

    return summary


async def get_schedule_status() -> Dict[str, Any]:
    """Return escalation status for all active patients with stage and color hints."""
    active_patients = []
    today = date.today()

    async with get_async_session() as session:
        patient_result = await session.execute(select(Patient).where(Patient.status == "active"))
        patients = patient_result.scalars().all()

        for patient in patients:
            days_until = 999
            if patient.expected_next_transfusion_date:
                days_until = max(0, (patient.expected_next_transfusion_date.date() - today).days)
            stage = _determine_stage(days_until)
            active_patients.append(
                {
                    "patient_id": patient.patient_id,
                    "days_until_transfusion": days_until,
                    "escalation_stage": stage,
                    "color_hint": _color_hint(days_until),
                }
            )

    return {"active_patients": active_patients}


scheduler.add_job(run_scheduler_scan, "interval", hours=24, id="escalation_scan_24h", replace_existing=True)
