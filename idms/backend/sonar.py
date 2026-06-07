from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import NotificationsLog, Donor


async def send_sonar_ping(
    patient_id: str,
    donor_ids: List[str],
    city_name: str,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Send location check broadcast to donors and return count and notification IDs."""
    async def _run(session: AsyncSession):
        message = (
            f"Hi, this is Priya from Blood Warriors. Are you currently in {city_name}? "
            f"We may need your help soon. Please reply YES or NO."
        )

        notification_ids = []
        for donor_id in donor_ids:
            notification = NotificationsLog(
                donor_id=donor_id,
                patient_id=patient_id,
                message=message,
                sent_at=datetime.utcnow(),
                channel="whatsapp_sim",
                notification_type="sonar_ping",
            )
            session.add(notification)
            await session.flush()
            if notification.id:
                notification_ids.append(notification.id)

        await session.commit()
        return {
            "pings_sent": len(donor_ids),
            "notification_ids_sample": notification_ids[:5],
            "total_notification_ids": len(notification_ids),
        }

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


async def process_sonar_response(
    notification_id: int,
    response: str,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Process a sonar response and return donor-patient pair with location status."""
    async def _run(session: AsyncSession):
        notification_result = await session.execute(
            select(NotificationsLog).where(NotificationsLog.id == notification_id)
        )
        notification = notification_result.scalars().first()

        if not notification:
            raise ValueError(f"Notification {notification_id} not found")

        notification.response = response
        responded_at = datetime.utcnow()
        notification.responded_at = responded_at
        session.add(notification)
        await session.flush()

        # If donor confirms in-city, update donor active status and last_contacted_date
        response_lower = response.lower()
        yes_keywords = ["yes", "y", "haan", "ha", "yep", "sure"]
        in_city = any(keyword in response_lower for keyword in yes_keywords)

        if in_city and notification.donor_id:
            donor_result = await session.execute(select(Donor).where(Donor.user_id == notification.donor_id))
            donor = donor_result.scalars().first()
            if donor:
                donor.user_donation_active_status = 'Active'
                donor.last_contacted_date = responded_at
                session.add(donor)

        await session.commit()

        return {
            "donor_id": notification.donor_id,
            "patient_id": notification.patient_id,
            "in_city": in_city,
            "notification_id": notification_id,
        }

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


async def get_sonar_results(
    patient_id: str,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Get sonar results for a patient including response counts and confirmed donors."""
    async def _run(session: AsyncSession):
        sonar_result = await session.execute(
            select(NotificationsLog).where(
                and_(
                    NotificationsLog.patient_id == patient_id,
                    NotificationsLog.notification_type == "sonar_ping",
                )
            )
        )
        notifications = sonar_result.scalars().all()

        total_sent = len(notifications)
        responded_yes = 0
        responded_no = 0
        no_response = 0
        donors_confirmed_in_city = []

        for notif in notifications:
            if notif.response is None:
                no_response += 1
            else:
                response_lower = notif.response.lower()
                yes_keywords = ["yes", "y", "haan", "ha", "yep", "sure"]
                if any(keyword in response_lower for keyword in yes_keywords):
                    responded_yes += 1
                    if notif.donor_id not in donors_confirmed_in_city:
                        donors_confirmed_in_city.append(notif.donor_id)
                else:
                    responded_no += 1

        return {
            "patient_id": patient_id,
            "total_sent": total_sent,
            "responded_yes": responded_yes,
            "responded_no": responded_no,
            "no_response": no_response,
            "donors_confirmed_in_city": donors_confirmed_in_city,
        }

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)
