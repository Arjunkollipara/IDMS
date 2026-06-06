import math
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from neo4j import GraphDatabase
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import Donor, Patient


def _get_neo4j_driver():
    from os import getenv

    uri = getenv("NEO4J_URI", "bolt://localhost:7687")
    user = getenv("NEO4J_USER", "neo4j")
    password = getenv("NEO4J_PASSWORD", "password")
    return GraphDatabase.driver(uri, auth=(user, password))


def haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance between two geographic coordinates in kilometers."""
    R = 6371
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _parse_neo4j_date(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None


def _relationship_score(donation_count: Optional[int]) -> float:
    if donation_count is None:
        return 0.0
    return min(120.0, float(donation_count) * 10.0)


def _category_bonus(donor_category: Optional[str], donor_type: Optional[str]) -> float:
    if donor_category == "Bridge Donor":
        return 20.0
    if donor_category == "Emergency Donor":
        return 10.0
    if donor_type == "Regular Donor":
        return 5.0
    return 0.0


async def rank_donors(
    patient_id: str,
    eligible_donor_ids: List[str],
    session: Optional[AsyncSession] = None,
) -> List[Dict[str, Any]]:
    """Score and rank eligible donors for a patient using relational and geographic criteria."""
    if not eligible_donor_ids:
        return []

    async def _run(session: AsyncSession):
        patient_result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = patient_result.scalars().first()
        if not patient:
            return []

        donor_result = await session.execute(
            select(Donor).where(Donor.user_id.in_(eligible_donor_ids))
        )
        donors = donor_result.scalars().all()

        donor_relationships: Dict[str, Dict[str, Any]] = {}
        try:
            driver = _get_neo4j_driver()
            with driver.session() as neo_session:
                records = neo_session.run(
                    """
                    MATCH (d:Donor)-[r:DONATED_FOR]->(p:Patient {patient_id: $patient_id})
                    WHERE d.user_id IN $donor_ids
                    RETURN d.user_id AS donor_id, r.donation_count AS donation_count, r.last_donation_date AS last_donation_date
                    """,
                    patient_id=patient_id,
                    donor_ids=eligible_donor_ids,
                )
                for record in records:
                    donor_relationships[record["donor_id"]] = {
                        "donation_count": record.get("donation_count"),
                        "last_donation_date": _parse_neo4j_date(record.get("last_donation_date")),
                    }
            driver.close()
        except Exception:
            donor_relationships = {}

        ranked: List[Dict[str, Any]] = []
        today = date.today()
        patient_lat = patient.latitude
        patient_lng = patient.longitude

        for donor in donors:
            edge = donor_relationships.get(donor.user_id, {})
            relationship_score = _relationship_score(edge.get("donation_count"))
            reliability_score = (donor.normalized_reliability_score or 0.0) * 30.0

            last_donation = edge.get("last_donation_date") or donor.last_donation_date
            recency_score = 0.0
            if last_donation:
                days_since = max(0, (today - last_donation.date()).days)
                recency_score = max(0.0, 30.0 - (days_since / 10.0))

            proximity_score = 0.0
            if patient_lat is None or patient_lng is None:
                proximity_score = 15.0
            elif donor.latitude is not None and donor.longitude is not None:
                distance_km = haversine(donor.latitude, donor.longitude, patient_lat, patient_lng)
                proximity_score = max(0.0, min(30.0, 30.0 - distance_km))

            category_bonus = _category_bonus(donor.donor_category, donor.donor_type)
            total_score = relationship_score + reliability_score + recency_score + proximity_score + category_bonus

            ranked.append(
                {
                    "donor_id": donor.user_id,
                    "blood_group": donor.blood_group,
                    "donor_category": donor.donor_category,
                    "donor_type": donor.donor_type,
                    "eligibility_status": donor.eligibility_status,
                    "relationship_score": relationship_score,
                    "reliability_score": reliability_score,
                    "recency_score": recency_score,
                    "proximity_score": proximity_score,
                    "category_bonus": category_bonus,
                    "total_score": total_score,
                    "last_donation_date": donor.last_donation_date.isoformat() if donor.last_donation_date else None,
                    "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
                    "normalized_reliability_score": donor.normalized_reliability_score,
                    "latitude": donor.latitude,
                    "longitude": donor.longitude,
                }
            )

        return sorted(ranked, key=lambda item: item["total_score"], reverse=True)

    if session is not None:
        return await _run(session)

    async with get_async_session() as session:
        return await _run(session)
