from datetime import datetime
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_async_session
from models import ConversationHistory


async def get_conversation_history(
    donor_id: str,
    patient_id: str,
    limit: int = 10,
    session: Optional[AsyncSession] = None,
) -> List[Dict[str, Any]]:
    """Retrieve conversation history for a donor-patient pair, oldest first for LLM context."""
    async def _run(session: AsyncSession):
        query = (
            select(ConversationHistory)
            .where(
                and_(
                    ConversationHistory.donor_id == donor_id,
                    ConversationHistory.patient_id == patient_id,
                )
            )
            .order_by(ConversationHistory.timestamp.desc())
            .limit(limit)
        )
        result = await session.execute(query)
        records = result.scalars().all()
        records.reverse()
        return [
            {
                "role": r.role,
                "message": r.message,
                "timestamp": r.timestamp.isoformat() if r.timestamp else None,
                "conversation_stage": r.conversation_stage,
            }
            for r in records
        ]

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


async def save_message(
    donor_id: str,
    patient_id: str,
    role: str,
    message: str,
    conversation_stage: str,
    session: Optional[AsyncSession] = None,
) -> int:
    """Save a message to conversation history and return the record ID."""
    async def _run(session: AsyncSession):
        record = ConversationHistory(
            donor_id=donor_id,
            patient_id=patient_id,
            role=role,
            message=message,
            timestamp=datetime.utcnow(),
            conversation_stage=conversation_stage,
        )
        session.add(record)
        await session.commit()
        await session.refresh(record)
        return record.id

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


async def get_conversation_stage(
    donor_id: str,
    patient_id: str,
    session: Optional[AsyncSession] = None,
) -> str:
    """Get the most recent conversation stage for a donor-patient pair."""
    async def _run(session: AsyncSession):
        query = (
            select(ConversationHistory)
            .where(
                and_(
                    ConversationHistory.donor_id == donor_id,
                    ConversationHistory.patient_id == patient_id,
                )
            )
            .order_by(ConversationHistory.timestamp.desc())
            .limit(1)
        )
        result = await session.execute(query)
        record = result.scalars().first()
        return record.conversation_stage if record else "initial_outreach"

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)


async def clear_conversation(
    donor_id: str,
    patient_id: str,
    session: Optional[AsyncSession] = None,
) -> int:
    """Delete all conversation history for a donor-patient pair and return count deleted."""
    async def _run(session: AsyncSession):
        query = delete(ConversationHistory).where(
            and_(
                ConversationHistory.donor_id == donor_id,
                ConversationHistory.patient_id == patient_id,
            )
        )
        result = await session.execute(query)
        await session.commit()
        return int(result.rowcount or 0)

    if session is not None:
        return await _run(session)
    async with get_async_session() as session:
        return await _run(session)
