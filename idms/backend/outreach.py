import os
from datetime import datetime
from typing import Any, Dict, Optional

import requests
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import Bridge, Donor, DonorPersonality, NotificationsLog, Patient


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


async def generate_outreach_message(
    donor_id: str,
    patient_id: str,
    stage: int,
    session: Optional[AsyncSession] = None,
) -> str:
    """Generate a warm outreach message based on escalation stage and donor history."""
    # Coerce stage to integer with tolerant mapping for legacy string inputs
    try:
        stage = int(stage)
    except Exception:
        stage_map = {"initial": 1, "one": 1, "1": 1, "two": 2, "2": 2, "final": 3, "three": 3, "3": 3}
        if isinstance(stage, str) and stage.lower() in stage_map:
            stage = stage_map[stage.lower()]
        else:
            try:
                stage = int(str(stage))
            except Exception:
                stage = 1

    async def _run(session: AsyncSession):
        donor_result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = donor_result.scalars().first()
        if not donor:
            return "Hi, we'd love your help with a patient in need."

        patient_result = await session.execute(select(Patient).where(Patient.patient_id == patient_id))
        patient = patient_result.scalars().first()

        blood_group = patient.blood_group if patient else "needed"

        bridge_result = await session.execute(
            select(Bridge).where(
                Bridge.donor_id == donor_id,
                Bridge.patient_id == patient_id,
            )
        )
        bridge = bridge_result.scalars().first()
        donation_count = bridge.donations_till_date if bridge else 0

        personality_result = await session.execute(
            select(DonorPersonality).where(DonorPersonality.donor_id == donor_id)
        )
        personality = personality_result.scalars().first()
        tone_hint = ""
        motivation_hint = ""
        if personality:
            if personality.communication_style == "emotional":
                tone_hint = "Use empathetic and heartfelt language that honors the donor's care."
            elif personality.communication_style == "brief":
                tone_hint = "Keep the message very short, direct, and easy to respond to."
            elif personality.communication_style == "recognition":
                tone_hint = "Thank the donor for their past support and highlight their impact."
            elif personality.communication_style == "formal":
                tone_hint = "Use polite, respectful language and complete sentences."
            elif personality.communication_style == "casual":
                tone_hint = "Use a friendly, conversational tone."

            if personality.motivation_type == "altruistic":
                motivation_hint = "Appeal to the donor's desire to help others and save lives."
            elif personality.motivation_type == "social":
                motivation_hint = "Mention the community effort and how their help joins others together."
            elif personality.motivation_type == "recognition":
                motivation_hint = "Reinforce that the donor is a reliable hero and their help is noticed."
            elif personality.motivation_type == "family":
                motivation_hint = "Remind the donor that their support helps families and loved ones."

        message_style = tone_hint or "Write a warm, respectful message."
        message_motivation = motivation_hint or "Mention impact and availability in a supportive way."
        if stage == 1:
            prompt = (
                f"Generate a warm WhatsApp message from Priya at Blood Warriors to a blood donor. "
                f"Donor has donated {donation_count} times before for this patient. "
                f"Patient needs blood in about 7 days. Blood group: {blood_group}. "
                f"{message_style} {message_motivation} "
                f"Reference their history kindly and ask if they are available. "
                f"Keep it under 60 words. No emojis. Natural Hindi-English mix optional."
            )
        elif stage == 2:
            prompt = (
                f"Generate an urgent but warm WhatsApp message. Transfusion is in 5 days. "
                f"Donor has donated {donation_count} times before for this patient. "
                f"{message_style} {message_motivation} "
                f"Ask for urgent help and mention that every hour counts. "
                f"Keep it under 60 words."
            )
        else:
            prompt = (
                f"Generate an urgent message. Transfusion is in 3 days. "
                f"Donor has donated {donation_count} times before. "
                f"{message_style} {message_motivation} "
                f"Mention that partner organizations are offering a small token of appreciation "
                f"(food voucher) for donors this week. Keep it under 60 words."
            )

        client = _get_azure_client()
        if client is None:
            fallback_messages = {
                1: f"Hi! We have a patient who really needs {blood_group} blood soon. You've helped before - would you be available this week? {motivation_hint}",
                2: f"Urgent: Our patient needs {blood_group} blood in 5 days. Your help makes all the difference! {motivation_hint}",
                3: f"Urgent: {blood_group} blood needed in 3 days. Plus, we're offering food vouchers for donors this week! {motivation_hint}",
            }
            return fallback_messages.get(stage, "We need your help with a patient in need.")

        try:
            deployment_name = os.getenv("AZURE_OPENAI_DEPLOYMENT_NAME", "gpt-4o")
            response = client.chat.completions.create(
                model=deployment_name,
                messages=[
                    {
                        "role": "system",
                        "content": "You are a message generator for a blood donation org. Generate exactly one message, nothing else.",
                    },
                    {
                        "role": "user",
                        "content": prompt,
                    },
                ],
                max_tokens=150,
                temperature=0.7,
            )
            return response.choices[0].message.content
        except Exception:
            fallback_messages = {
                1: f"Hi! We have a patient who really needs {blood_group} blood soon. You've helped before - would you be available this week? {motivation_hint}",
                2: f"Urgent: Our patient needs {blood_group} blood in 5 days. Your help makes all the difference! {motivation_hint}",
                3: f"Urgent: {blood_group} blood needed in 3 days. Plus, we're offering food vouchers for donors this week! {motivation_hint}",
            }
            return fallback_messages.get(stage, "We need your help with a patient in need.")

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


def translate_message(text: str, target_language_code: str) -> str:
    """Translate message to target language using Azure Translator, or return original if unavailable."""
    if target_language_code == "en":
        return text

    translator_key = os.getenv("AZURE_TRANSLATOR_KEY", "")
    translator_endpoint = os.getenv("AZURE_TRANSLATOR_ENDPOINT", "")

    if not translator_key or not translator_endpoint:
        return text

    supported_langs = ["hi", "te", "ta", "kn", "mr", "en"]
    if target_language_code not in supported_langs:
        return text

    try:
        url = f"{translator_endpoint}/translate?api-version=3.0&to={target_language_code}"
        headers = {
            "Ocp-Apim-Subscription-Key": translator_key,
            "Content-Type": "application/json",
        }
        body = [{"text": text}]
        response = requests.post(url, headers=headers, json=body, timeout=10)
        if response.status_code == 200:
            result = response.json()
            if result and len(result) > 0:
                return result[0]["translations"][0]["text"]
    except Exception:
        pass

    return text
