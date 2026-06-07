import os
from datetime import date, datetime
from typing import Any, Dict, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from memory import get_conversation_history, save_message, get_conversation_stage
from models import Bridge, Donor, DonorPersonality, Patient


def _get_azure_client():
    """Initialize Azure OpenAI client with credentials from environment."""
    try:
        from openai import AzureOpenAI

        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "")
        api_key = os.getenv("AZURE_OPENAI_API_KEY", "")
        if not endpoint or not api_key:
            import logging
            logging.getLogger(__name__).warning(
                "Azure OpenAI not configured: AZURE_OPENAI_ENDPOINT=%r AZURE_OPENAI_API_KEY set=%s",
                endpoint, bool(api_key)
            )
            return None

        return AzureOpenAI(
            azure_endpoint=endpoint,
            api_key=api_key,
            api_version="2024-02-01",
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("Failed to init AzureOpenAI client: %s", exc)
        return None


def _parse_communication_style(text: str) -> str:
    cleaned = (text or "").lower()
    if len(cleaned) < 80 and any(word in cleaned for word in ["ok", "sure", "yes", "available", "yup"]):
        return "brief"
    if any(word in cleaned for word in ["heart", "care", "feel", "hope", "child", "family", "pray"]):
        return "emotional"
    if any(word in cleaned for word in ["please", "thank", "appreciate", "kindly", "regards"]):
        return "formal"
    if any(word in cleaned for word in ["hi", "hey", "cool", "thanks", "ya"]):
        return "casual"
    return "neutral"


def _parse_motivation_type(text: str) -> str:
    cleaned = (text or "").lower()
    if any(word in cleaned for word in ["help", "support", "care", "impact", "saved"]):
        return "altruistic"
    if any(word in cleaned for word in ["together", "community", "friends", "social"]):
        return "social"
    if any(word in cleaned for word in ["proud", "rank", "leader", "top donor", "appreciate"]):
        return "recognition"
    if any(word in cleaned for word in ["family", "child", "mother", "father", "sister", "brother"]):
        return "family"
    return "neutral"


def _sentiment_score(text: str) -> int:
    cleaned = (text or "").lower()
    if any(word in cleaned for word in ["good", "great", "happy", "glad", "yes", "sure"]):
        return 1
    if any(word in cleaned for word in ["not", "can't", "cannot", "unable", "sorry", "no"]):
        return -1
    return 0


def _format_bridge_history(bridge: Optional[Bridge], donor: Optional[Donor]) -> str:
    donations_till_date = bridge.donations_till_date if bridge and bridge.donations_till_date is not None else 0
    last_bridge_date = None
    if bridge and bridge.last_bridge_donation_date:
        last_bridge_date = bridge.last_bridge_donation_date.date().isoformat()
    reliability = donor.normalized_reliability_score if donor and donor.normalized_reliability_score is not None else None
    active_status = donor.user_donation_active_status if donor else None
    parts = [f"donations_for_this_patient={donations_till_date}"]
    parts.append(f"last_bridge_donation_date={last_bridge_date or 'unknown'}")
    parts.append(f"normalized_reliability_score={reliability if reliability is not None else 'unknown'}")
    parts.append(f"user_donation_active_status={active_status or 'unknown'}")
    return ", ".join(parts)


async def build_context(
    donor_id: str,
    patient_id: str,
    session: Optional[AsyncSession] = None,
) -> str:
    """Build donor-patient context from database for LLM awareness."""
    async def _run(session: AsyncSession):
        donor_result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = donor_result.scalars().first()

        patient_result = await session.execute(select(Patient).where(Patient.patient_id == patient_id))
        patient = patient_result.scalars().first()

        bridge_result = await session.execute(
            select(Bridge).where(
                and_(
                    Bridge.donor_id == donor_id,
                    Bridge.patient_id == patient_id,
                )
            )
        )
        bridge = bridge_result.scalars().first()

        donor_history_result = await session.execute(
            select(Bridge).where(Bridge.donor_id == donor_id).order_by(Bridge.last_bridge_donation_date.desc())
        )
        all_bridges = donor_history_result.scalars().all()
        patient_ids = {entry.patient_id for entry in all_bridges if entry.patient_id}

        context_parts = []

        if donor:
            context_parts.append(
                "Donor context: "
                f"blood_group={donor.blood_group}, "
                f"donations_till_date={donor.donations_till_date or 0}, "
                f"last_donation_date={donor.last_donation_date.date().isoformat() if donor.last_donation_date else 'unknown'}, "
                f"next_eligible_date={donor.next_eligible_date.date().isoformat() if donor.next_eligible_date else 'unknown'}, "
                f"lives_impacted={len(patient_ids)}, "
                f"patients_donated_for={len(patient_ids)}"
            )

        if patient:
            criticality = "unknown"
            if patient.expected_next_transfusion_date:
                days_until = (patient.expected_next_transfusion_date.date() - date.today()).days
                criticality = "critical" if days_until <= 3 else "urgent" if days_until <= 7 else "stable"
            context_parts.append(
                "Patient context: "
                f"patient_id={patient.patient_id}, "
                f"blood_group={patient.blood_group}, "
                f"frequency_in_days={patient.frequency_in_days}, "
                f"expected_next_transfusion_date={patient.expected_next_transfusion_date.date().isoformat() if patient.expected_next_transfusion_date else 'unknown'}, "
                f"criticality={criticality}"
            )

        if bridge:
            context_parts.append(f"Relationship context: donated {bridge.donations_till_date or 0} times for this patient")
            if bridge.last_bridge_donation_date:
                days_since = (date.today() - bridge.last_bridge_donation_date.date()).days
                context_parts.append(f"days_since_last_donation_for_this_patient={days_since}")
            context_parts.append(f"bridge_history={_format_bridge_history(bridge, donor)}")

        return ". ".join(context_parts)

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


def _determine_next_stage(incoming_message: str, current_stage: str) -> str:
    message_lower = (incoming_message or "").lower()
    if any(keyword in message_lower for keyword in ["yes", "haan", "ha", "available", "sure", "ok", "okay"]):
        return "confirmation"
    if any(keyword in message_lower for keyword in ["location", "city", "where", "here", "there"]):
        return "location_check"
    if any(keyword in message_lower for keyword in ["thanks", "thank", "donated", "done", "completed"]):
        return "post_donation_thanks"
    return current_stage


def _get_fallback_response(stage: str, donor_name: str = "Friend") -> str:
    responses = {
        "initial_outreach": f"Hi {donor_name}, I can help if the timing works. Please share the details and I will respond.",
        "location_check": "Yes, I'm currently in the city and available to help if needed.",
        "confirmation": "Yes, I am available. Please let me know the next steps.",
        "post_donation_thanks": "You're welcome. I'm glad I could help, and I appreciate the update.",
        "long_term_engagement": "Thank you for keeping in touch. Please let me know about future needs.",
    }
    return responses.get(stage, f"Hi {donor_name}, thanks for being part of our community.")


def _build_history_fallback(
    stage: str,
    donor: Optional[Donor],
    patient: Optional[Patient],
    bridge: Optional[Bridge],
    sender: str = "donor",
) -> str:
    if sender in ("coordinator", "patient"):
        donor_name = donor.user_id if donor else "Donor"
        return f"Hi, thank you for reaching out. I'm happy to help and support you as a donor."

    donations_till_date = bridge.donations_till_date if bridge and bridge.donations_till_date is not None else 0
    last_bridge_date = (
        bridge.last_bridge_donation_date.date().isoformat()
        if bridge and bridge.last_bridge_donation_date
        else "unknown"
    )
    patient_next = (
        patient.expected_next_transfusion_date.date().isoformat()
        if patient and patient.expected_next_transfusion_date
        else "soon"
    )
    donor_label = donor.user_id if donor and donor.user_id else "Friend"

    if stage == "location_check":
        return (
            f"Hi {donor_label}, I'm checking if I'm currently in the city and able to help. "
            f"I've donated {donations_till_date} times for this patient, last on {last_bridge_date}."
        )
    if stage == "confirmation":
        return (
            f"Yes, I can donate and help again. I've supported this patient {donations_till_date} times, and the next transfusion around {patient_next} works for me."
        )
    if stage == "post_donation_thanks":
        return "You're welcome. I'm glad I could help again and I appreciate the update."
    if stage == "long_term_engagement":
        return "I care about this patient and am happy to stay engaged. Please keep me informed about future needs."
    return f"Hi {donor_label}, I can help if the timing works. I've donated {donations_till_date} times for this patient, last on {last_bridge_date}."


def _build_system_prompt(
    donor_name: str,
    donor: Optional[Donor],
    patient: Optional[Patient],
    personality: Optional[DonorPersonality],
    context: str,
    sender: str = "donor",
) -> str:
    if sender in ("coordinator", "patient"):
        style_intro = "Write warmly and respectfully."
        if personality:
            if personality.communication_style == "emotional":
                style_intro = "Write with emotional warmth, empathy, and gratitude."
            elif personality.communication_style == "brief":
                style_intro = "Write a very short and direct response (1-2 sentences)."
            elif personality.communication_style == "formal":
                style_intro = "Use polite and respectful language with complete sentences."
            elif personality.communication_style == "casual":
                style_intro = "Use a relaxed, friendly, and casual tone."
        
        donor_blood = donor.blood_group if donor else "O Positive"
        patient_name = patient.patient_id if patient and patient.patient_id else "the patient"
        return (
            f"You are {donor_name}, a kind and helpful blood donor of blood group {donor_blood}. "
            f"You are speaking to the patient ({patient_name}) or a coordinator who is chatting with you. "
            f"{style_intro} "
            f"Respond directly and naturally to their message. If they are thanking you, say you are happy to help "
            f"and support them. Do not ask coordinator questions like pincode or contact number. "
            f"Do not mention that you are an AI. Be a warm, real human donor."
        )

    style_intro = "Write warmly and respectfully."
    if personality:
        if personality.communication_style == "emotional":
            style_intro = "Use emotionally warm language, show empathy, and mention how the patient is feeling."
        elif personality.communication_style == "brief":
            style_intro = "Write a short and direct response in two or three sentences."
        elif personality.communication_style == "recognition":
            style_intro = "Mention the donor's impact, appreciation, and their importance to the community."
        elif personality.communication_style == "formal":
            style_intro = "Use polite and respectful language with complete sentences."
        elif personality.communication_style == "casual":
            style_intro = "Use a relaxed and friendly tone, in short conversational phrases."

    motivation_intro = ""
    if personality:
        if personality.motivation_type == "altruistic":
            motivation_intro = "Appeal to the donor's desire to help and support others."
        elif personality.motivation_type == "social":
            motivation_intro = "Mention how the donor can be part of a community effort."
        elif personality.motivation_type == "recognition":
            motivation_intro = "Highlight the donor's reliability and the lives they have impacted."
        elif personality.motivation_type == "family":
            motivation_intro = "Refer to the importance of family and personal support."

    patient_name = patient.patient_id if patient and patient.patient_id else "the patient"
    patient_group = patient.blood_group if patient else "their blood group"
    criticality = "unknown"
    if patient and patient.expected_next_transfusion_date:
        days_until = (patient.expected_next_transfusion_date.date() - date.today()).days
        criticality = "critical" if days_until <= 3 else "urgent" if days_until <= 7 else "stable"
    transfusion_date = patient.expected_next_transfusion_date.date().isoformat() if patient and patient.expected_next_transfusion_date else "soon"

    donation_history = ""
    if donor:
        donation_history = (
            f"{donor_name} has donated {donor.donations_till_date or 0} times, "
            f"last donation {donor.last_donation_date.date().isoformat() if donor and donor.last_donation_date else 'unknown'}, "
            f"next eligible {donor.next_eligible_date.date().isoformat() if donor and donor.next_eligible_date else 'unknown'}."
        )

    return (
        f"You are Priya, a warm and empathetic blood donation coordinator speaking to {donor_name}. "
        f"{style_intro} {motivation_intro} "
        f"Patient context: {patient_name} needs {patient_group} blood, transfusion on {transfusion_date}. The case is {criticality}. "
        f"{donation_history} {context} "
        "You guide the donor through a structured donation interview by asking these questions ONE AT A TIME in order:\n"
        "1. Are you available to donate? (yes/no)\n"
        "2. What city or area will you be donating from? (location)\n"
        "3. What is your pincode? (pincode)\n"
        "4. Can we confirm your contact number on file? (yes/no)\n"
        "5. What date works best for you? (availability_date)\n"
        "Ask only ONE question at a time. Wait for the donor's answer before asking the next. "
        "Once all 5 answers are collected, say: 'Thank you! Your details have been recorded and our coordinator will confirm shortly.' "
        "Do not mention that you are an AI. Be warm, brief, and encouraging."
    )


async def _load_personality_profile(donor_id: str, session: AsyncSession) -> Optional[DonorPersonality]:
    result = await session.execute(select(DonorPersonality).where(DonorPersonality.donor_id == donor_id))
    return result.scalars().first()


async def _update_personality_profile(
    donor_id: str,
    incoming_text: str,
    response_text: str,
    session: AsyncSession,
) -> DonorPersonality:
    personality = await _load_personality_profile(donor_id, session)
    if personality is None:
        personality = DonorPersonality(donor_id=donor_id, sentiment_history=[])

    style = _parse_communication_style(incoming_text)
    motivation = _parse_motivation_type(incoming_text)
    sentiment = _sentiment_score(incoming_text)

    personality.communication_style = style or personality.communication_style or "neutral"
    personality.motivation_type = motivation or personality.motivation_type or "neutral"
    personality.sentiment_history = (personality.sentiment_history or []) + [sentiment]
    personality.sentiment_history = personality.sentiment_history[-20:]
    personality.total_conversations = (personality.total_conversations or 0) + 1
    personality.last_personality_update = datetime.utcnow()

    history = await get_conversation_history(donor_id, None, limit=20, session=session)
    response_times = []
    for index in range(1, len(history)):
        prev = history[index - 1]
        current = history[index]
        if prev.get("role") == "user" and current.get("role") == "assistant" and prev.get("timestamp") and current.get("timestamp"):
            try:
                prev_ts = datetime.fromisoformat(prev["timestamp"])
                current_ts = datetime.fromisoformat(current["timestamp"])
                delta = (current_ts - prev_ts).total_seconds() / 3600.0
                if delta >= 0:
                    response_times.append(delta)
            except Exception:
                continue
    if response_times:
        personality.avg_response_time_hours = sum(response_times) / len(response_times)
        personality.response_rate = round(min(1.0, max(0.0, len(response_times) / max(1, len(response_times) + 1))), 2)

    session.add(personality)
    await session.commit()
    await session.refresh(personality)
    return personality


# ---------------------------------------------------------------------------
# Confirmation word detection helpers
# ---------------------------------------------------------------------------

_CONFIRMATION_WORDS = [
    'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay',
    'haan', 'ha', 'available', 'confirm', 'confirmed',
    'i can', 'i will', 'will help', 'ready',
    'can donate', 'can help', 'i am available',
    'i\'m available', 'i\'ll help', 'definitely',
]

# Phrases that mean "yes but uncertain" — these trigger coordinator handoff
_UNCERTAIN_WORDS = [
    "maybe", "might", "possibly", "probably", "not sure", "i think so",
    "i'll try", "ill try", "i can try", "will try", "try to",
    "hope so", "should be", "most likely", "if possible",
    "let me check", "let me see", "i'll see", "ill see",
    "depends", "can't promise", "cannot promise", "not 100",
    "i wish", "i hope", "uncertain", "unsure",
]


def _is_confirmation(text: str) -> bool:
    """Return True if the donor message contains any confirmation phrase."""
    lower = (text or '').lower()
    return any(word in lower for word in _CONFIRMATION_WORDS)


def _is_uncertain_confirmation(text: str) -> bool:
    """Return True if donor is hesitantly agreeing — needs coordinator handoff."""
    lower = (text or '').lower()
    has_uncertain = any(phrase in lower for phrase in _UNCERTAIN_WORDS)
    # Must also have some positive signal to be a hesitant YES (not a plain no)
    has_positive = any(w in lower for w in ['yes', 'can', 'will', 'help', 'try', 'maybe', 'possibly', 'probably', 'hope', 'wish'])
    return has_uncertain and has_positive


async def _save_confirmation_notification(
    donor_id: str,
    patient_id: str,
    incoming_message: str,
    session: AsyncSession,
) -> bool:
    """
    Insert a donation_accepted notification if none exists yet for this
    donor+patient today, returning True if a new record was created.
    """
    import logging
    try:
        from models import NotificationsLog  # local import to avoid circular
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        existing = await session.execute(
            select(NotificationsLog).where(
                and_(
                    NotificationsLog.donor_id == donor_id,
                    NotificationsLog.patient_id == patient_id,
                    NotificationsLog.notification_type == 'donation_accepted',
                    NotificationsLog.sent_at >= today_start,
                )
            )
        )
        if existing.scalars().first() is not None:
            return False  # duplicate — skip

        notif = NotificationsLog(
            donor_id=donor_id,
            patient_id=patient_id,
            message=f'Donor confirmed availability via chat. Said: {incoming_message}',
            notification_type='donation_accepted',
            sent_at=datetime.utcnow(),
            channel='chat',
            response=incoming_message,
            responded_at=datetime.utcnow(),
        )
        session.add(notif)
        await session.flush()   # write within the current transaction
        logging.getLogger(__name__).info(
            '[confirmation] saved donation_accepted for donor=%s patient=%s', donor_id, patient_id
        )
        return True
    except Exception as exc:
        logging.getLogger(__name__).error(
            '[confirmation] failed to save notification: %s', exc
        )
        return False


async def _save_handoff_notification(
    donor_id: str,
    patient_id: str,
    donor_message: str,
    session: AsyncSession,
) -> bool:
    """Flag this conversation for coordinator handoff if not already flagged today."""
    import logging
    try:
        from models import NotificationsLog
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

        # Check if already flagged today (avoid duplicate alerts)
        existing = await session.execute(
            select(NotificationsLog).where(
                and_(
                    NotificationsLog.donor_id == donor_id,
                    NotificationsLog.patient_id == patient_id,
                    NotificationsLog.notification_type == 'coordinator_handoff_needed',
                    NotificationsLog.sent_at >= today_start,
                )
            )
        )
        if existing.scalars().first() is not None:
            return False  # already flagged

        notif = NotificationsLog(
            donor_id=donor_id,
            patient_id=patient_id,
            message=f'Donor gave uncertain response — coordinator handoff needed. Said: "{donor_message}"',
            notification_type='coordinator_handoff_needed',
            sent_at=datetime.utcnow(),
            channel='chat',
            response=donor_message,
            responded_at=datetime.utcnow(),
        )
        session.add(notif)
        await session.flush()
        logging.getLogger(__name__).info(
            '[handoff] flagged coordinator_handoff_needed for donor=%s patient=%s', donor_id, patient_id
        )
        return True
    except Exception as exc:
        logging.getLogger(__name__).error('[handoff] failed to save handoff notification: %s', exc)
        return False


async def is_handoff_open(donor_id: str, patient_id: str, session: AsyncSession) -> bool:
    """Return True if there is an open (unclosed) coordinator handoff for this donor+patient."""
    from models import NotificationsLog

    # Find the most recent handoff_needed
    needed_result = await session.execute(
        select(NotificationsLog)
        .where(
            and_(
                NotificationsLog.donor_id == donor_id,
                NotificationsLog.patient_id == patient_id,
                NotificationsLog.notification_type == 'coordinator_handoff_needed',
            )
        )
        .order_by(NotificationsLog.sent_at.desc())
        .limit(1)
    )
    needed = needed_result.scalars().first()
    if needed is None:
        return False

    # Find the most recent handoff_closed
    closed_result = await session.execute(
        select(NotificationsLog)
        .where(
            and_(
                NotificationsLog.donor_id == donor_id,
                NotificationsLog.patient_id == patient_id,
                NotificationsLog.notification_type == 'coordinator_handoff_closed',
            )
        )
        .order_by(NotificationsLog.sent_at.desc())
        .limit(1)
    )
    closed = closed_result.scalars().first()

    # Open if no close exists, or if the close happened before the latest open
    if closed is None:
        return True
    return needed.sent_at > closed.sent_at


async def chat(
    donor_id: str,
    patient_id: str,
    incoming_message: str,
    sender: str = "donor",
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    async def _run(session: AsyncSession):
        history = await get_conversation_history(donor_id, patient_id, limit=10, session=session)
        context = await build_context(donor_id, patient_id, session=session)
        current_stage = await get_conversation_stage(donor_id, patient_id, session=session)

        donor_result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = donor_result.scalars().first()
        patient_result = await session.execute(select(Patient).where(Patient.patient_id == patient_id))
        patient = patient_result.scalars().first()

        bridge_result = await session.execute(
            select(Bridge).where(
                and_(
                    Bridge.donor_id == donor_id,
                    Bridge.patient_id == patient_id,
                )
            )
        )
        bridge = bridge_result.scalars().first()
        donor_name = donor.user_id if donor and donor.user_id else "Friend"

        personality = await _load_personality_profile(donor_id, session)
        system_prompt = _build_system_prompt(donor_name, donor, patient, personality, context, sender=sender)

        client = _get_azure_client()
        if client is None:
            response_text = _build_history_fallback(current_stage, donor, patient, bridge, sender=sender)
            next_stage = current_stage
        else:
            try:
                messages = [
                    {"role": "system", "content": system_prompt}
                ]
                for msg in history:
                    if sender == "donor":
                        llm_role = "user" if msg["role"] == "donor" else "assistant"
                    else:
                        llm_role = "user" if msg["role"] in ("coordinator", "patient") else "assistant"
                    messages.append({"role": llm_role, "content": msg["message"]})
                messages.append({"role": "user", "content": incoming_message})

                deployment_name = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "gpt-4o")
                api_response = client.chat.completions.create(
                    model=deployment_name,
                    messages=messages,
                    max_tokens=220,
                    temperature=0.65,
                )

                response_text = api_response.choices[0].message.content
                next_stage = _determine_next_stage(incoming_message, current_stage)
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error("Azure OpenAI call failed: %s", exc)
                response_text = _build_history_fallback(current_stage, donor, patient, bridge, sender=sender)
                next_stage = current_stage

        incoming_role = sender
        response_role = "donor" if sender in ("coordinator", "patient") else "coordinator"

        await save_message(donor_id, patient_id, incoming_role, incoming_message, current_stage, session=session)
        await save_message(donor_id, patient_id, response_role, response_text, next_stage, session=session)
        await _update_personality_profile(donor_id, incoming_message, response_text, session=session)

        # --- Confirmation detection: save notification if donor said yes ---
        confirmed = False
        uncertain = False
        handoff_needed = False
        
        if sender == "donor":
            confirmed = _is_confirmation(incoming_message)
            uncertain = _is_uncertain_confirmation(incoming_message)

            if confirmed and not uncertain:
                await _save_confirmation_notification(donor_id, patient_id, incoming_message, session)
            elif uncertain:
                # Donor is hesitating — flag for coordinator handoff
                handoff_needed = await _save_handoff_notification(donor_id, patient_id, incoming_message, session)
        
        # --- Notification logic for patient/coordinator chats ---
        if sender in ("coordinator", "patient"):
            try:
                from models import NotificationsLog
                notif = NotificationsLog(
                    donor_id=donor_id,
                    patient_id=patient_id,
                    message=f"Patient sent a message: {incoming_message}" if sender == "patient" else f"Coordinator sent a message: {incoming_message}",
                    notification_type="chat_message",
                    sent_at=datetime.utcnow(),
                    channel="chat",
                )
                session.add(notif)
                await session.flush()
            except Exception as exc:
                import logging
                logging.getLogger(__name__).error("Failed to save chat notification for donor: %s", exc)

        return {
            "response": response_text,
            "conversation_stage": next_stage,
            "donor_id": donor_id,
            "patient_id": patient_id,
            "handoff_needed": handoff_needed,
            "uncertain_confirmation": uncertain,
        }

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)
