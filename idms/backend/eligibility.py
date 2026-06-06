from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple, Union

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import Donor, Patient


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
    """Return eligible donors for a patient and counts grouped by donor category."""
    async def _run(session: AsyncSession):
        required_date_parsed = _coerce_date(required_date)
        required_end = datetime.combine(required_date_parsed, datetime.max.time())

        patient_result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = patient_result.scalars().first()

        if not patient or not patient.blood_group:
            return [], {}

        query = select(Donor).where(
            and_(
                Donor.blood_group == patient.blood_group,
                Donor.user_donation_active_status == "Active",
                or_(Donor.next_eligible_date == None, Donor.next_eligible_date <= required_end),
                or_(Donor.eligibility_status == None, Donor.eligibility_status != "not eligible"),
            )
        )

        result = await session.execute(query)
        donors = result.scalars().all()

        eligible_donors: List[Dict[str, Any]] = []
        count_by_category: Dict[str, int] = {}

        for donor in donors:
            donor_category = donor.donor_category or "Unknown"
            count_by_category[donor_category] = count_by_category.get(donor_category, 0) + 1
            eligible_donors.append(
                {
                    "donor_id": donor.user_id,
                    "blood_group": donor.blood_group,
                    "eligibility_status": donor.eligibility_status,
                    "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
                    "donor_category": donor_category,
                }
            )

        return eligible_donors, count_by_category

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)
