from datetime import datetime, date, timedelta
from typing import Dict, Any, Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_async_session
from models import DonationInterviewSession, DonationHistory, DonorActivityLog, Donor, NotificationsLog

# Define the interview questions and their keys
QUESTIONS = [
    {"key": "availability", "question": "Are you available to donate? (yes/no)"},
    {"key": "location", "question": "What city or area will you be donating from?"},
    {"key": "pincode", "question": "What is your pincode?"},
    {"key": "contact_confirmed", "question": "Can we confirm your contact number on file? (yes/no)"},
    {"key": "availability_date", "question": "What date works best for you? (e.g. tomorrow, or DD/MM/YYYY)"},
]


async def start_interview(donor_id: str, patient_id: str, session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    async def _run(session: AsyncSession):
        # cancel any existing in-progress session
        existing = await session.execute(
            select(DonationInterviewSession).where(
                DonationInterviewSession.donor_id == donor_id,
                DonationInterviewSession.patient_id == patient_id,
                DonationInterviewSession.status == 'in_progress'
            )
        )
        for old in existing.scalars().all():
            old.status = 'cancelled'
            session.add(old)

        s = DonationInterviewSession(donor_id=donor_id, patient_id=patient_id, question_index=0, answers={}, status="in_progress")
        session.add(s)
        await session.commit()
        await session.refresh(s)
        first_q = QUESTIONS[0]["question"] if QUESTIONS else "Thank you."
        return {"session_id": s.id, "question": first_q, "question_key": QUESTIONS[0]["key"]}

    if session is not None:
        return await _run(session)
    async with get_async_session() as sess:
        return await _run(sess)


async def answer_next(donor_id: str, patient_id: str, message: str, session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    async def _run(session: AsyncSession):
        # find active session
        result = await session.execute(
            select(DonationInterviewSession).where(DonationInterviewSession.donor_id == donor_id, DonationInterviewSession.patient_id == patient_id, DonationInterviewSession.status == 'in_progress')
        )
        s = result.scalars().first()
        if not s:
            # start new if none
            started = await start_interview(donor_id, patient_id, session=session)
            return {"started": True, "next_question": started["question"], "finished": False}

        idx = s.question_index
        if idx < len(QUESTIONS):
            key = QUESTIONS[idx]["key"]
            answers = dict(s.answers or {})
            answers[key] = message
            s.answers = answers
            s.question_index = idx + 1
            s.updated_at = datetime.utcnow()
            session.add(s)
            await session.commit()
            # If more questions remain, return next
            if s.question_index < len(QUESTIONS):
                next_q = QUESTIONS[s.question_index]["question"]
                return {"next_question": next_q, "question_key": QUESTIONS[s.question_index]["key"], "finished": False}
            else:
                return {"finished": True}
        return {"finished": True}

    if session is not None:
        return await _run(session)
    async with get_async_session() as sess:
        return await _run(sess)


def _parse_yes_no(text: str) -> Optional[bool]:
    t = (text or '').lower()
    if any(w in t for w in ['yes', 'yup', 'sure', 'ok', 'available', 'haan', 'ha']):
        return True
    if any(w in t for w in ['no', "don't", "do not", "can't", "cannot", "unable"]):
        return False
    return None


async def submit_interview(donor_id: str, patient_id: str, session: Optional[AsyncSession] = None) -> Dict[str, Any]:
    async def _run(session: AsyncSession):
        result = await session.execute(
            select(DonationInterviewSession).where(DonationInterviewSession.donor_id == donor_id, DonationInterviewSession.patient_id == patient_id, DonationInterviewSession.status == 'in_progress')
        )
        s = result.scalars().first()
        if not s:
            return {"success": False, "error": "no active interview"}

        answers = s.answers or {}
        # Map answers to DonationHistory
        dh = DonationHistory(
            donor_id=donor_id,
            patient_id=patient_id,
            blood_group=None,
            availability_date=answers.get('availability_date'),
            location=answers.get('location'),
            pincode=answers.get('pincode'),
            contact_confirmed=_parse_yes_no(answers.get('contact_confirmed')),
            timestamp=datetime.utcnow(),
            status='pending',
        )
        session.add(dh)

        # update donor donations count
        donor_res = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = donor_res.scalars().first()
        if donor:
            donor.donations_till_date = (donor.donations_till_date or 0) + 1
            donor.last_donation_date = datetime.utcnow()
            session.add(donor)

        # mark interview complete
        s.status = 'completed'
        s.updated_at = datetime.utcnow()
        session.add(s)

        # donor activity log
        log = DonorActivityLog(donor_id=donor_id, action='donation_interview_completed', details={'answers': answers})
        session.add(log)

        # notify coordinator via NotificationsLog
        notif = NotificationsLog(
            donor_id=donor_id,
            patient_id=patient_id,
            message=f'Donor {donor_id[:14]}... confirmed availability. Location: {answers.get("location", "unknown")}, Pincode: {answers.get("pincode", "unknown")}, Date: {answers.get("availability_date", "unknown")}',
            notification_type='donation_accepted',
            channel='system',
        )
        session.add(notif)

        await session.commit()
        await session.refresh(dh)

        return {"success": True, "donation_form_id": dh.id, "answers": answers}

    if session is not None:
        return await _run(session)
    async with get_async_session() as sess:
        return await _run(sess)