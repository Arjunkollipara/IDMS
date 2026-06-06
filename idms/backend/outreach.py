import os
from datetime import datetime
from typing import Any, Dict, Optional

import requests
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import Bridge, Donor, NotificationsLog, Patient


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

        if stage == 1:
            prompt = (
                f"Generate a warm WhatsApp message from Priya at Blood Warriors to a blood donor. "
                f"Donor has donated {donation_count} times before for this patient. "
                f"Patient needs blood in about 7 days. Blood group: {blood_group}. "
                f"Reference their history warmly. Ask if they are available. "
                f"Keep it under 60 words. No emojis. Natural Hindi-English mix optional."
            )
        elif stage == 2:
            prompt = (
                f"Generate an urgent but warm WhatsApp message. Transfusion is in 5 days. "
                f"Donor has donated {donation_count} times. Ask for urgent help. "
                f"Keep it under 60 words."
            )
        else:
            prompt = (
                f"Generate an urgent message. Transfusion is in 3 days. "
                f"Mention that partner organizations are offering a small token of appreciation "
                f"(food voucher) for donors this week. Keep it under 60 words."
            )

        client = _get_azure_client()
        if client is None:
            fallback_messages = {
                1: f"Hi! We have a patient who really needs {blood_group} blood soon. You've helped before - would you be available this week?",
                2: f"Urgent: Our patient needs {blood_group} blood in 5 days. Your help makes all the difference!",
                3: f"Urgent: {blood_group} blood needed in 3 days. Plus, we're offering food vouchers for donors this week!",
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
                1: f"Hi! We have a patient who really needs {blood_group} blood soon. You've helped before - would you be available this week?",
                2: f"Urgent: Our patient needs {blood_group} blood in 5 days. Your help makes all the difference!",
                3: f"Urgent: {blood_group} blood needed in 3 days. Plus, we're offering food vouchers for donors this week!",
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
