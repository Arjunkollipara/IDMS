from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

from neo4j import GraphDatabase
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from eligibility import get_eligible_donors
from models import Donor, EscalationLog, ReservationLog


def _get_neo4j_driver():
    from os import getenv

    uri = getenv("NEO4J_URI", "bolt://localhost:7687")
    user = getenv("NEO4J_USER", "neo4j")
    password = getenv("NEO4J_PASSWORD", "password")
    return GraphDatabase.driver(uri, auth=(user, password))


def _coerce_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time())
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    raise ValueError("transfusion_date must be a date, datetime, or ISO string")


async def reserve_donor(
    donor_id: str,
    patient_id: str,
    transfusion_date: Any,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Reserve a donor for a patient and lock their next eligible date."""
    transfusion_datetime = _coerce_datetime(transfusion_date)

    async def _run(session: AsyncSession):
        eligible_donors, _ = await get_eligible_donors(patient_id, transfusion_datetime.date(), session=session)
        eligible_ids = {item["donor_id"] for item in eligible_donors}
        if donor_id not in eligible_ids:
            raise ValueError("Donor is not eligible for reservation on the requested date")

        reservation_result = await session.execute(
            select(ReservationLog).where(
                ReservationLog.donor_id == donor_id,
                ReservationLog.status == "reserved",
            )
        )
        if reservation_result.scalars().first():
            raise ValueError("Donor already has an active reserved booking")

        donor_result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = donor_result.scalars().first()
        if not donor:
            raise ValueError("Donor not found")

        original_next = donor.next_eligible_date
        donor.next_eligible_date = transfusion_datetime + timedelta(days=90)
        donor.eligibility_status = "reserved"
        session.add(donor)

        reservation = ReservationLog(
            donor_id=donor_id,
            patient_id=patient_id,
            transfusion_date=transfusion_datetime,
            status="reserved",
            reserved_at=datetime.utcnow(),
            original_next_eligible_date=original_next,
        )
        session.add(reservation)
        await session.commit()

        try:
            driver = _get_neo4j_driver()
            with driver.session() as neo_session:
                neo_session.run(
                    """
                    MERGE (d:Donor {user_id: $donor_id})
                    SET d.reserved = true
                    """,
                    donor_id=donor_id,
                )
            driver.close()
        except Exception:
            pass

        return {
            "reservation_id": reservation.id,
            "donor_id": donor_id,
            "patient_id": patient_id,
            "transfusion_date": transfusion_datetime.isoformat(),
            "status": "reserved",
        }

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)


async def confirm_reservation(
    reservation_id: int,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Confirm a reservation as completed and update donor and Neo4j donation history."""
    async def _run(session: AsyncSession):
        reservation_result = await session.execute(
            select(ReservationLog).where(ReservationLog.id == reservation_id)
        )
        reservation = reservation_result.scalars().first()
        if not reservation:
            raise ValueError("Reservation not found")

        donor_result = await session.execute(select(Donor).where(Donor.user_id == reservation.donor_id))
        donor = donor_result.scalars().first()
        if not donor:
            raise ValueError("Donor not found")

        transfusion_datetime = reservation.transfusion_date
        if not transfusion_datetime:
            raise ValueError("Reservation does not contain a valid transfusion date")

        reservation.status = "completed"
        session.add(reservation)

        donor.eligibility_status = "eligible"
        donor.next_eligible_date = transfusion_datetime + timedelta(days=90)
        donor.last_donation_date = transfusion_datetime
        donor.donations_till_date = (donor.donations_till_date or 0) + 1
        session.add(donor)

        escalation_entry = EscalationLog(
            patient_id=reservation.patient_id,
            trigger_date=datetime.utcnow(),
            stage=None,
            action_taken="reservation_confirmed",
            outcome="donated",
        )
        session.add(escalation_entry)

        await session.commit()

        try:
            driver = _get_neo4j_driver()
            with driver.session() as neo_session:
                neo_session.run(
                    """
                    MERGE (d:Donor {user_id: $donor_id})
                    MERGE (p:Patient {patient_id: $patient_id})
                    MERGE (d)-[r:DONATED_FOR]->(p)
                    SET r.donation_count = coalesce(r.donation_count, 0) + 1,
                        r.last_donation_date = $last_donation_date
                    """,
                    donor_id=donor.user_id,
                    patient_id=reservation.patient_id,
                    last_donation_date=transfusion_datetime.isoformat(),
                )
            driver.close()
        except Exception:
            pass

        return {
            "success": True,
            "reservation_id": reservation.id,
            "donor_id": donor.user_id,
            "patient_id": reservation.patient_id,
            "status": reservation.status,
            "donations_till_date": donor.donations_till_date,
            "last_donation_date": donor.last_donation_date.isoformat() if donor.last_donation_date else None,
            "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
        }

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)


async def release_reservation(
    reservation_id: int,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Release an active reservation and restore donor eligibility."""
    async def _run(session: AsyncSession):
        reservation_result = await session.execute(
            select(ReservationLog).where(ReservationLog.id == reservation_id)
        )
        reservation = reservation_result.scalars().first()
        if not reservation:
            raise ValueError("Reservation not found")

        donor_result = await session.execute(select(Donor).where(Donor.user_id == reservation.donor_id))
        donor = donor_result.scalars().first()
        if not donor:
            raise ValueError("Donor not found")

        donor.eligibility_status = "eligible"
        donor.next_eligible_date = reservation.original_next_eligible_date or (reservation.transfusion_date + timedelta(days=90))
        session.add(donor)

        reservation.status = "released"
        session.add(reservation)
        await session.commit()

        try:
            driver = _get_neo4j_driver()
            with driver.session() as neo_session:
                neo_session.run(
                    """
                    MATCH (d:Donor {user_id: $donor_id})
                    SET d.reserved = false
                    """,
                    donor_id=donor.user_id,
                )
            driver.close()
        except Exception:
            pass

        return {
            "success": True,
            "reservation_id": reservation.id,
            "donor_id": donor.user_id,
            "status": reservation.status,
            "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
        }

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)


async def list_reservations(
    patient_id: Optional[str] = None,
    donor_id: Optional[str] = None,
    status: Optional[str] = None,
    session: Optional[AsyncSession] = None,
) -> List[Dict[str, Any]]:
    """Return filtered reservation records."""
    async def _run(session: AsyncSession):
        query = select(ReservationLog)
        if patient_id:
            query = query.where(ReservationLog.patient_id == patient_id)
        if donor_id:
            query = query.where(ReservationLog.donor_id == donor_id)
        if status:
            query = query.where(ReservationLog.status == status)

        result = await session.execute(query)
        reservations = result.scalars().all()

        return [
            {
                "reservation_id": entry.id,
                "donor_id": entry.donor_id,
                "patient_id": entry.patient_id,
                "transfusion_date": entry.transfusion_date.isoformat() if entry.transfusion_date else None,
                "reserved_at": entry.reserved_at.isoformat() if entry.reserved_at else None,
                "status": entry.status,
            }
            for entry in reservations
        ]

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)
