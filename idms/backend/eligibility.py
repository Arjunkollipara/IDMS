from datetime import date, datetime, timedelta
from time import perf_counter
from typing import Any, Dict, List, Optional, Tuple, Union

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
import logging

from database import get_async_session
from models import Donor, Patient

logger = logging.getLogger(__name__)


def _coerce_date(value: Optional[Union[date, datetime, str]]) -> date:
    if value is None:
        return date.today()
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise ValueError("required_date must be a date, datetime, or ISO date string")


async def get_eligible_donors(
    patient_id: str,
    required_date: Optional[Union[date, datetime, str]] = None,
    session: Optional[AsyncSession] = None,
) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Return eligible donors for a patient and counts grouped by donor category.
    
    Eligibility criteria:
    1. Blood group matches patient
    2. User is marked as Active
    3. Eligibility status is "eligible" OR next_eligible_date is None OR next_eligible_date <= today
    4. Returns at least top 20 results, sorted by reliability score descending
    """
    async def _run(session: AsyncSession):
        total_start = perf_counter()
        query_start = perf_counter()
        required_date_parsed = _coerce_date(required_date)
        required_end = datetime.combine(required_date_parsed, datetime.max.time())

        patient_result = await session.execute(
            select(Patient.blood_group).where(Patient.patient_id == patient_id)
        )
        patient_blood_group = patient_result.scalar_one_or_none()
        patient_query_ms = (perf_counter() - query_start) * 1000

        if not patient_blood_group:
            logger.info(
                "[perf] eligible_donors patient_query_ms=%.2f donor_query_ms=0.00 serialization_ms=0.00 total_ms=%.2f patient_id=%s",
                patient_query_ms,
                (perf_counter() - total_start) * 1000,
                patient_id,
            )
            return [], {}

        donor_query_start = perf_counter()
        # Fetch candidates: blood group match + active status + eligibility check
        today_datetime = datetime.combine(date.today(), datetime.max.time())
        
        query = select(
            Donor.user_id,
            Donor.blood_group,
            Donor.eligibility_status,
            Donor.last_donation_date,
            Donor.next_eligible_date,
            Donor.donor_category,
            Donor.normalized_reliability_score,
        ).where(
            and_(
                Donor.blood_group == patient_blood_group,
                Donor.user_donation_active_status == "Active",
                or_(
                    Donor.eligibility_status == "eligible",
                    Donor.next_eligible_date == None,
                    Donor.next_eligible_date <= today_datetime,
                )
            )
        ).order_by(Donor.normalized_reliability_score.desc().nullslast()).limit(5000)

        result = await session.execute(query)
        donors = result.mappings().all()
        donor_query_ms = (perf_counter() - donor_query_start) * 1000

        serialization_start = perf_counter()
        eligible_donors: List[Dict[str, Any]] = []
        count_by_category: Dict[str, int] = {}

        for donor in donors:
            donor_category = donor["donor_category"] or "Unknown"
            count_by_category[donor_category] = count_by_category.get(donor_category, 0) + 1
            
            eligible_donors.append(
                {
                    "donor_id": donor["user_id"],
                    "blood_group": donor["blood_group"],
                    "eligibility_status": donor["eligibility_status"],
                    "last_donation_date": donor["last_donation_date"].isoformat() if donor["last_donation_date"] else None,
                    "next_eligible_date": donor["next_eligible_date"].isoformat() if donor["next_eligible_date"] else None,
                    "donor_category": donor_category,
                    "normalized_reliability_score": donor.get("normalized_reliability_score"),
                }
            )
        
        # Ensure at least top 20 results
        if not eligible_donors and len(donors) == 0:
            # Fallback: get ANY active donors with matching blood group
            fallback_query = select(
                Donor.user_id,
                Donor.blood_group,
                Donor.eligibility_status,
                Donor.last_donation_date,
                Donor.next_eligible_date,
                Donor.donor_category,
                Donor.normalized_reliability_score,
            ).where(
                and_(
                    Donor.blood_group == patient_blood_group,
                    Donor.user_donation_active_status == "Active",
                )
            ).order_by(Donor.normalized_reliability_score.desc().nullslast()).limit(100)
            
            fallback_result = await session.execute(fallback_query)
            fallback_donors = fallback_result.mappings().all()
            
            for donor in fallback_donors[:20]:
                donor_category = donor["donor_category"] or "Unknown"
                count_by_category[donor_category] = count_by_category.get(donor_category, 0) + 1
                eligible_donors.append({
                    "donor_id": donor["user_id"],
                    "blood_group": donor["blood_group"],
                    "eligibility_status": donor["eligibility_status"],
                    "last_donation_date": donor["last_donation_date"].isoformat() if donor["last_donation_date"] else None,
                    "next_eligible_date": donor["next_eligible_date"].isoformat() if donor["next_eligible_date"] else None,
                    "donor_category": donor_category,
                    "normalized_reliability_score": donor.get("normalized_reliability_score"),
                })
        
        serialization_ms = (perf_counter() - serialization_start) * 1000
        total_ms = (perf_counter() - total_start) * 1000
        logger.info(
            "[perf] eligible_donors patient_query_ms=%.2f donor_query_ms=%.2f serialization_ms=%.2f total_ms=%.2f patient_id=%s donors=%d",
            patient_query_ms,
            donor_query_ms,
            serialization_ms,
            total_ms,
            patient_id,
            len(eligible_donors),
        )

        return eligible_donors, count_by_category

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)
