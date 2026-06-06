import os
from datetime import date
from typing import Any, Dict, Optional

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from memory import get_conversation_history, save_message, get_conversation_stage
from models import Bridge, Donor, Patient

SYSTEM_PROMPT = """You are Priya, a warm and empathetic care coordinator for Blood Warriors 
Foundation, an organization that connects voluntary blood donors with 
Thalassemia patients across India. You coordinate blood donations on behalf 
of specific patients who need regular transfusions to survive.

You know each donor personally through their donation history. You communicate 
naturally, warmly, and never robotically. You speak in simple conversational 
language. You never pressure donors. You always respect their decision. 
You remember previous conversations and reference them naturally.

Your goal in each conversation depends on the stage:
- initial_outreach: Gently introduce the need, reference their history if any
- location_check: Ask if they are currently in the city
- confirmation: Confirm their availability and guide them to donate
- post_donation_thanks: Express genuine gratitude, share patient update if known
- long_term_engagement: Maintain the relationship, share impact

Always be brief. 2-4 sentences maximum per response. 
Never mention being an AI. You are Priya."""


def _get_azure_client():
    """Initialize Azure OpenAI client with credentials from environment."""
    try:
        from openai import AzureOpenAI

        endpoint = os.getenv("AZURE_OPENAI_ENDPOINT", "")
        if not endpoint:
            return None

        return AzureOpenAI(
            azure_endpoint=endpoint,
            api_key=os.getenv("AZURE_OPENAI_API_KEY"),
            api_version="2024-02-01",
        )
    except Exception:
        return None


def _format_bridge_history(bridge: Optional[Bridge], donor: Optional[Donor]) -> str:
    """Summarize the donor's actual history with this patient for prompts and fallbacks."""
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

        context_parts = []

        if donor:
            context_parts.append(
                "Donor: "
                f"blood_group={donor.blood_group}, "
                f"donor_category={donor.donor_category}, "
                f"donations_till_date={bridge.donations_till_date if bridge and bridge.donations_till_date is not None else donor.donations_till_date}, "
                f"last_bridge_donation_date={bridge.last_bridge_donation_date.date().isoformat() if bridge and bridge.last_bridge_donation_date else 'unknown'}, "
                f"normalized_reliability_score={donor.normalized_reliability_score if donor.normalized_reliability_score is not None else 'unknown'}, "
                f"user_donation_active_status={donor.user_donation_active_status}"
            )

        if patient:
            context_parts.append(
                "Patient: "
                f"blood_group={patient.blood_group}, "
                f"frequency_in_days={patient.frequency_in_days}, "
                f"expected_next_transfusion_date={patient.expected_next_transfusion_date.date().isoformat() if patient.expected_next_transfusion_date else 'unknown'}"
            )
            if patient.expected_next_transfusion_date:
                context_parts.append(f"Next transfusion: {patient.expected_next_transfusion_date.date().isoformat()}")

        if bridge:
            context_parts.append(f"Relationship: donated {bridge.donations_till_date or 0} times for this patient")
            if bridge.last_bridge_donation_date:
                days_since = (date.today() - bridge.last_bridge_donation_date.date()).days
                context_parts.append(f"Days since last donation for this patient: {days_since}")
            context_parts.append(f"Bridge history: {_format_bridge_history(bridge, donor)}")

        return ". ".join(context_parts)

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


def _determine_next_stage(incoming_message: str, current_stage: str) -> str:
    """Determine conversation stage based on message content."""
    message_lower = incoming_message.lower()

    yes_keywords = ["yes", "haan", "ha", "available", "yesss", "sure", "ok", "okay"]
    if any(keyword in message_lower for keyword in yes_keywords):
        return "confirmation"

    location_keywords = ["location", "city", "where", "here", "there"]
    if any(keyword in message_lower for keyword in location_keywords):
        return "location_check"

    thanks_keywords = ["thanks", "thank", "donated", "done", "completed"]
    if any(keyword in message_lower for keyword in thanks_keywords):
        return "post_donation_thanks"

    return current_stage


def _get_fallback_response(stage: str, donor_name: str = "Friend") -> str:
    """Return a warm templated response when Azure is unavailable."""
    responses = {
        "initial_outreach": f"Hi {donor_name}, hope you're doing well! A patient we care for really needs your help soon. Would you be available this week? 💙",
        "location_check": f"Just checking - are you currently in the city? Your help could make a real difference.",
        "confirmation": f"Thank you so much for stepping up. Let's confirm the details and get you ready to help.",
        "post_donation_thanks": f"Thank you, {donor_name}! Your donation just saved a life. We're so grateful for you.",
        "long_term_engagement": f"{donor_name}, your consistent help means everything to our patient. They ask about you!",
    }
    return responses.get(stage, f"Hi {donor_name}, thanks for being part of our community.")


def _build_history_fallback(
    stage: str,
    donor: Optional[Donor],
    patient: Optional[Patient],
    bridge: Optional[Bridge],
) -> str:
    """Build a fallback reply that still references the donor's actual donation history."""
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
            f"Hi {donor_label}, just checking if you are currently in the city. "
            f"You have supported this patient {donations_till_date} times before, and your last donation was {last_bridge_date}. "
            "Please reply yes or no when you can."
        )
    if stage == "confirmation":
        return (
            f"Hi {donor_label}, thank you for helping this patient {donations_till_date} times already. "
            f"The next transfusion is expected around {patient_next}. "
            "If you are available, I can help with the next steps."
        )
    if stage == "post_donation_thanks":
        return (
            f"Hi {donor_label}, thank you again for your support {donations_till_date} times for this patient. "
            f"Your last donation on {last_bridge_date} made a real difference. "
            "We are truly grateful."
        )
    if stage == "long_term_engagement":
        return (
            f"Hi {donor_label}, your support for this patient has already happened {donations_till_date} times. "
            f"That kind of consistency means a lot, especially with the next transfusion expected around {patient_next}. "
            "We value staying in touch with you."
        )
    return (
        f"Hi {donor_label}, I am reaching out because this patient has received your help {donations_till_date} times before. "
        f"Your last donation was on {last_bridge_date}, and the next transfusion is expected around {patient_next}. "
        "Would you be available to help again?"
    )


async def chat(
    donor_id: str,
    patient_id: str,
    incoming_message: str,
    session: Optional[AsyncSession] = None,
) -> Dict[str, Any]:
    """Process a chat message and return response with updated conversation stage."""
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

        client = _get_azure_client()
        if client is None:
            response_text = _build_history_fallback(current_stage, donor, patient, bridge)
            next_stage = current_stage
        else:
            try:
                messages = [
                    {
                        "role": "system",
                        "content": f"{SYSTEM_PROMPT}\n\nContext: {context}",
                    }
                ]

                for msg in history:
                    messages.append(
                        {
                            "role": msg["role"],
                            "content": msg["message"],
                        }
                    )

                messages.append(
                    {
                        "role": "user",
                        "content": incoming_message,
                    }
                )

                deployment_name = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "gpt-4o")
                api_response = client.chat.completions.create(
                    model=deployment_name,
                    messages=messages,
                    max_tokens=200,
                    temperature=0.7,
                )

                response_text = api_response.choices[0].message.content
                next_stage = _determine_next_stage(incoming_message, current_stage)
            except Exception:
                response_text = _build_history_fallback(current_stage, donor, patient, bridge)
                next_stage = current_stage

        await save_message(donor_id, patient_id, "user", incoming_message, current_stage, session=session)
        await save_message(donor_id, patient_id, "assistant", response_text, next_stage, session=session)

        return {
            "response": response_text,
            "conversation_stage": next_stage,
            "donor_id": donor_id,
            "patient_id": patient_id,
        }

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)
