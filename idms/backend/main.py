import os
import logging
from datetime import date, datetime, timedelta
from time import perf_counter
from typing import List, Optional
from urllib.parse import unquote
from fastapi import FastAPI, Depends, Query, HTTPException, Body, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from celery.result import AsyncResult
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from contextlib import asynccontextmanager
import asyncio


def sanitize_float(value):
    if value is None:
        return None
    try:
        f = float(value)
        import math
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return value


def normalize_donor_id(donor_id: str) -> str:
    """Normalize donor ID to always start with exactly one backslash."""
    if not donor_id:
        return donor_id
    decoded = unquote(donor_id)
    return '\\' + decoded.lstrip('\\')


# Import database and models
from database import get_db, check_db_connection, engine, async_session
from agent import chat as chat_agent, is_handoff_open
from celery_app import app as celery_app
from eligibility import get_eligible_donors
from ranking import rank_donors
from memory import clear_conversation, save_message
from outreach import generate_outreach_message, translate_message
from donation import start_interview, answer_next, submit_interview
from scheduler import scheduler, run_scheduler_scan, get_schedule_status
from reservation import reserve_donor, confirm_reservation, release_reservation, list_reservations
from sonar import get_sonar_results, process_sonar_response, send_sonar_ping
from models import (
    Base,
    Bridge,
    ConversationHistory,
    Donor,
    DonorPersonality,
    EscalationLog,
    EscalationPool,
    LearningLog,
    NotificationsLog,
    DonationInterviewSession,
    DonationHistory,
    DonorActivityLog,
    Patient,
    ReservationLog,
)
from ingest import ingest_data
from tasks.daily_scan import run_daily_scan
from tasks.escalation import trigger_escalation_workflow

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def build_donor_badges(donor: Donor, personality: Optional[DonorPersonality] = None):
    total_donations = donor.donations_till_date or 0
    current_streak = donor.cycle_of_donations or 0
    reliability_score = sanitize_float(donor.normalized_reliability_score or 0) or 0

    badges = [
        {
            "name": "First Donation",
            "earned": total_donations >= 1,
            "description": "Completed the first blood donation.",
        },
        {
            "name": "5 Donations",
            "earned": total_donations >= 5,
            "description": "Reached five total donations.",
        },
        {
            "name": "10 Donations",
            "earned": total_donations >= 10,
            "description": "Reached ten total donations.",
        },
        {
            "name": "Regular Donor",
            "earned": current_streak >= 3,
            "description": "Donated three or more times in the current donation cycle.",
        },
        {
            "name": "Reliable Responder",
            "earned": reliability_score >= 70,
            "description": "Maintains a strong reliability score based on donation history.",
        },
    ]

    if personality:
        badges.append(
            {
                "name": "Responsive Communicator",
                "earned": (personality.response_rate or 0) >= 0.7,
                "description": "Consistently responds quickly to donation requests.",
            }
        )
    else:
        badges.append(
            {
                "name": "Committed Donor",
                "earned": total_donations >= 3,
                "description": "Has donated multiple times and remains actively engaged.",
            }
        )

    return badges


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for app startup/shutdown"""
    # Startup
    logger.info("Application startup")
    
    # Create tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.exec_driver_sql(
            "ALTER TABLE reservation_log ADD COLUMN IF NOT EXISTS original_next_eligible_date TIMESTAMP;"
        )
        await conn.exec_driver_sql(
            "ALTER TABLE donation_history ADD COLUMN IF NOT EXISTS pincode VARCHAR;"
        )

    scheduler.start()

    # Seed demo-patient-001 if it doesn't exist
    try:
        async with async_session() as session:
            result = await session.execute(select(Patient).where(Patient.patient_id == "demo-patient-001"))
            patient = result.scalars().first()
            if not patient:
                logger.info("Seeding demo-patient-001")
                patient = Patient(
                    patient_id="demo-patient-001",
                    blood_group="O Positive",
                    gender="Male",
                    frequency_in_days=21,
                    last_transfusion_date=datetime.utcnow() - timedelta(days=19),
                    expected_next_transfusion_date=datetime.utcnow() + timedelta(days=2),
                    status="active",
                    registration_date=datetime.utcnow() - timedelta(days=30),
                )
                session.add(patient)
                await session.commit()
                logger.info("demo-patient-001 seeded successfully")
    except Exception as e:
        logger.error(f"Failed to seed demo-patient-001: {str(e)}")

    await run_scheduler_scan()
    
    yield
    
    # Shutdown
    logger.info("Application shutdown")
    scheduler.shutdown(wait=False)
    await engine.dispose()


app = FastAPI(
    title="IDMS - Intelligent Donation Management System",
    description="AI-powered wrapper layer over Blood Warriors Foundation's blood donation platform",
    version="1.0.0",
    lifespan=lifespan
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def enforce_cors_headers(request: Request, call_next):
    response = await call_next(request)
    origin = request.headers.get("origin")
    if origin in {"http://localhost:5173", "http://localhost:5174", "http://localhost:3000"}:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers.setdefault("Access-Control-Allow-Methods", "*")
        response.headers.setdefault("Access-Control-Allow-Headers", "*")
        response.headers["Vary"] = "Origin"
    return response


class ChatRequest(BaseModel):
    """Capture the data required to send one conversation message."""
    donor_id: str
    patient_id: str
    message: str
    sender: Optional[str] = "donor"


class OutreachRequest(BaseModel):
    """Capture the optional outreach language preference and optional target donor."""
    language_code: str = "en"
    draft_only: bool = False
    donor_id: Optional[str] = None


class SonarRespondRequest(BaseModel):
    """Capture a sonar response from a donor."""
    notification_id: int
    response: str


class ClearConversationRequest(BaseModel):
    """Capture the donor-patient pair whose history should be cleared."""
    donor_id: str
    patient_id: str


class SaveMessageRequest(BaseModel):
    """Request model for saving coordinator messages."""
    donor_id: str
    patient_id: str
    message: str
    role: str


class NotifyDonorRequest(BaseModel):
    """Request model for sending a simulated notification to a donor."""
    donor_id: str
    patient_id: str
    message: str
    stage: int


class AdminAlertRequest(BaseModel):
    """Capture the information needed to log an admin alert."""
    patient_id: str
    message: str


# ============================================================================
# HEALTH CHECK ENDPOINTS
# ============================================================================

async def check_neo4j_connection():
    """Check Neo4j connection"""
    try:
        from neo4j import GraphDatabase
        NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
        NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
        NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
        
        driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
        with driver.session() as session:
            session.run("RETURN 1")
        driver.close()
        return True
    except Exception as e:
        logger.error(f"Neo4j connection failed: {str(e)}")
        return False


async def get_table_counts(session: AsyncSession):
    """Get row counts for all tables"""
    try:
        counts = {}
        
        # Count donors
        result = await session.execute(select(Donor))
        counts['donors'] = len(result.scalars().all())
        
        # Count patients
        result = await session.execute(select(Patient))
        counts['patients'] = len(result.scalars().all())
        
        # Count bridges
        result = await session.execute(select(Bridge))
        counts['bridges'] = len(result.scalars().all())
        
        # Count escalation pool
        result = await session.execute(select(EscalationPool))
        counts['escalation_pool'] = len(result.scalars().all())
        
        return counts
    except Exception as e:
        logger.error(f"Failed to get table counts: {str(e)}")
        return {}


@app.get("/health")
async def health_check(session: AsyncSession = Depends(get_db)):
    """
    Health check endpoint returning:
    - API status
    - Database connection status
    - Neo4j connection status
    - Row counts for all tables
    """
    try:
        db_status = await check_db_connection()
        neo4j_status = await check_neo4j_connection()
        counts = await get_table_counts(session)
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "status": "healthy" if db_status and neo4j_status else "degraded",
                "api_status": "running",
                "database_status": "connected" if db_status else "disconnected",
                "neo4j_status": "connected" if neo4j_status else "disconnected",
                "table_counts": counts,
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "status": "unhealthy",
                "error": str(e),
            }
        )


# ============================================================================
# DONOR ENDPOINTS
# ============================================================================

@app.get("/donors")
async def list_donors(
    category: Optional[str] = Query(None),
    blood_group: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(default=50, le=10000),
    session: AsyncSession = Depends(get_db)
):
    """
    Get filtered list of donors
    
    Query parameters:
    - category: Filter by donor category (Bridge Donor, Emergency Donor, Guest, Volunteer)
    - blood_group: Filter by blood group
    - status: Filter by user_donation_active_status
    - limit: Number of results (default 50, max 1000)
    """
    try:
        query = select(Donor)
        
        if category:
            query = query.where(Donor.donor_category == category)
        if blood_group:
            query = query.where(Donor.blood_group == blood_group)
        if status:
            query = query.where(Donor.user_donation_active_status == status)
        
        query = query.limit(limit)
        result = await session.execute(query)
        donors = result.scalars().all()
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(donors),
                "donors": [
                    {
                        "user_id": d.user_id,
                        "blood_group": d.blood_group,
                        "gender": d.gender,
                        "donor_category": d.donor_category,
                        "normalized_reliability_score": d.normalized_reliability_score,
                        "donations_till_date": d.donations_till_date,
                        "eligibility_status": d.eligibility_status,
                        "user_donation_active_status": d.user_donation_active_status,
                    }
                    for d in donors
                ]
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/all")
async def get_all_donors(session: AsyncSession = Depends(get_db)):
    """
    Get all donors with basic info for donor selection dropdown
    """
    try:
        result = await session.execute(select(Donor))
        donors = result.scalars().all()
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(donors),
                "donors": [
                    {
                        "user_id": d.user_id,
                        "blood_group": d.blood_group,
                        "donations_till_date": d.donations_till_date or 0,
                        "eligibility_status": d.eligibility_status,
                        "user_donation_active_status": d.user_donation_active_status,
                    }
                    for d in donors
                ]
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}")
async def get_donor(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get full donor profile
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(
            select(Donor).where(Donor.user_id == donor_id)
        )
        donor = result.scalars().first()
        
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )

        personality_result = await session.execute(
            select(DonorPersonality).where(DonorPersonality.donor_id == donor_id)
        )
        personality = personality_result.scalars().first()
        personality_payload = None
        if personality:
            personality_payload = {
                "communication_style": personality.communication_style,
                "motivation_type": personality.motivation_type,
                "response_rate": personality.response_rate,
                "avg_response_time_hours": personality.avg_response_time_hours,
                "total_conversations": personality.total_conversations,
                "last_personality_update": personality.last_personality_update.isoformat() if personality.last_personality_update else None,
                "preferred_contact_time": personality.preferred_contact_time,
                "sentiment_history": personality.sentiment_history,
            }

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor": {
                    "user_id": donor.user_id,
                    "blood_group": donor.blood_group,
                    "gender": donor.gender,
                    "latitude": donor.latitude,
                    "longitude": donor.longitude,
                    "last_donation_date": donor.last_donation_date.isoformat() if donor.last_donation_date else None,
                    "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
                    "donations_till_date": sanitize_float(donor.donations_till_date),
                    "eligibility_status": donor.eligibility_status,
                    "total_calls": sanitize_float(donor.total_calls),
                    "calls_to_donations_ratio": sanitize_float(donor.calls_to_donations_ratio),
                    "normalized_reliability_score": sanitize_float(donor.normalized_reliability_score),
                    "user_donation_active_status": donor.user_donation_active_status,
                    "inactive_trigger_comment": donor.inactive_trigger_comment,
                    "registration_date": donor.registration_date.isoformat() if donor.registration_date else None,
                    "last_contacted_date": donor.last_contacted_date.isoformat() if donor.last_contacted_date else None,
                    "donor_type": donor.donor_type,
                    "donor_category": donor.donor_category,
                    "cycle_of_donations": sanitize_float(donor.cycle_of_donations),
                    "frequency_in_days": sanitize_float(donor.frequency_in_days),
                    "status": donor.status,
                    "donated_earlier": donor.donated_earlier,
                    "role_status": donor.role_status,
                    "personality": personality_payload,
                }
            }
        )
    except Exception as e:
        logger.exception(f"Error fetching donor profile for {donor_id}")
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.put("/donors/{donor_id}")
async def update_donor(donor_id: str, payload: dict = Body(...), session: AsyncSession = Depends(get_db)):
    """
    Update the donor profile with partial fields.
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = result.scalars().first()
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )

        allowed_fields = {
            "blood_group",
            "gender",
            "latitude",
            "longitude",
            "last_donation_date",
            "next_eligible_date",
            "donations_till_date",
            "eligibility_status",
            "total_calls",
            "calls_to_donations_ratio",
            "normalized_reliability_score",
            "user_donation_active_status",
            "inactive_trigger_comment",
            "donor_type",
            "donor_category",
            "cycle_of_donations",
            "frequency_in_days",
            "status",
            "donated_earlier",
            "role_status",
        }

        date_fields = {"last_donation_date", "next_eligible_date"}
        for key, value in payload.items():
            if key not in allowed_fields:
                continue
            if key in date_fields and isinstance(value, str):
                try:
                    value = datetime.fromisoformat(value)
                except ValueError:
                    pass
            setattr(donor, key, value)

        session.add(donor)
        await session.commit()
        await session.refresh(donor)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor": {
                    "user_id": donor.user_id,
                    "blood_group": donor.blood_group,
                    "gender": donor.gender,
                    "latitude": donor.latitude,
                    "longitude": donor.longitude,
                    "last_donation_date": donor.last_donation_date.isoformat() if donor.last_donation_date else None,
                    "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
                    "donations_till_date": donor.donations_till_date,
                    "eligibility_status": donor.eligibility_status,
                    "total_calls": donor.total_calls,
                    "calls_to_donations_ratio": donor.calls_to_donations_ratio,
                    "normalized_reliability_score": donor.normalized_reliability_score,
                    "user_donation_active_status": donor.user_donation_active_status,
                    "inactive_trigger_comment": donor.inactive_trigger_comment,
                    "registration_date": donor.registration_date.isoformat() if donor.registration_date else None,
                    "last_contacted_date": donor.last_contacted_date.isoformat() if donor.last_contacted_date else None,
                    "donor_type": donor.donor_type,
                    "donor_category": donor.donor_category,
                    "cycle_of_donations": donor.cycle_of_donations,
                    "frequency_in_days": donor.frequency_in_days,
                    "status": donor.status,
                    "donated_earlier": donor.donated_earlier,
                    "role_status": donor.role_status,
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}/badges")
async def get_donor_badges(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get donor achievement badges from donor history and personality data.
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = result.scalars().first()

        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )

        personality_result = await session.execute(
            select(DonorPersonality).where(DonorPersonality.donor_id == donor_id)
        )
        personality = personality_result.scalars().first()
        badges = build_donor_badges(donor, personality)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "badges": badges,
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.post("/donors/{donor_id}/badges/recalculate")
async def recalculate_donor_badges(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Recalculate and return donor badges after updating donor history.
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(select(Donor).where(Donor.user_id == donor_id))
        donor = result.scalars().first()

        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )

        personality_result = await session.execute(
            select(DonorPersonality).where(DonorPersonality.donor_id == donor_id)
        )
        personality = personality_result.scalars().first()

        badges = build_donor_badges(donor, personality)

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "badges": badges,
                "recalculated": True,
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}/streak")
async def get_donor_streak(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get donor's donation streak information
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(
            select(Donor).where(Donor.user_id == donor_id)
        )
        donor = result.scalars().first()
        
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "streak": {
                    "current_streak": donor.cycle_of_donations or 0,
                    "longest_streak": donor.cycle_of_donations or 0,
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}/impact")
async def get_donor_impact(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get donor's impact metrics
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(
            select(Donor).where(Donor.user_id == donor_id)
        )
        donor = result.scalars().first()
        
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )
        
        # Calculate years active
        years_active = 0
        if donor.registration_date:
            years_active = (date.today() - donor.registration_date.date()).days // 365
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "impact": {
                    "lives_impacted": donor.donations_till_date or 0,
                    "total_units": donor.donations_till_date or 0,
                    "years_active": years_active,
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}/rank")
async def get_donor_rank(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get donor's ranking percentile
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(
            select(Donor).where(Donor.user_id == donor_id)
        )
        donor = result.scalars().first()
        
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )
        
        # Calculate percentile based on reliability score
        all_donors = await session.execute(select(Donor))
        all_donor_scores = [d.normalized_reliability_score or 0 for d in all_donors.scalars().all()]
        
        if not all_donor_scores:
            percentile = 50
        else:
            donor_score = donor.normalized_reliability_score or 0
            rank_count = sum(1 for score in all_donor_scores if score <= donor_score)
            percentile = round((rank_count / len(all_donor_scores)) * 100)
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "rank": {
                    "percentile": f"Top {percentile}%",
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/donors/{donor_id}/eligibility-countdown")
async def get_donor_eligibility_countdown(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get donor's eligibility countdown to next donation
    """
    try:
        donor_id = normalize_donor_id(donor_id)
        result = await session.execute(
            select(Donor).where(Donor.user_id == donor_id)
        )
        donor = result.scalars().first()
        
        if not donor:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Donor not found"}
            )
        
        days_until = 0
        if donor.next_eligible_date:
            delta = donor.next_eligible_date.date() - date.today()
            days_until = max(0, delta.days)
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "donor_id": donor_id,
                "countdown": {
                    "days_until_eligible": days_until,
                    "next_eligible_date": donor.next_eligible_date.isoformat() if donor.next_eligible_date else None,
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================================
# PATIENT ENDPOINTS
# ============================================================================

@app.get("/patients")
async def list_patients(
    blood_group: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(default=50, le=10000),
    session: AsyncSession = Depends(get_db)
):
    """
    Get filtered list of patients
    
    Query parameters:
    - blood_group: Filter by blood group
    - status: Filter by status (default is active)
    - limit: Number of results (default 50, max 1000)
    """
    try:
        query = select(Patient)
        
        if blood_group:
            query = query.where(Patient.blood_group == blood_group)
        if status:
            query = query.where(Patient.status == status)
        
        query = query.limit(limit)
        result = await session.execute(query)
        patients = result.scalars().all()
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(patients),
                "patients": [
                    {
                        "patient_id": p.patient_id,
                        "blood_group": p.blood_group,
                        "gender": p.gender,
                        "frequency_in_days": p.frequency_in_days,
                        "last_transfusion_date": p.last_transfusion_date.isoformat() if p.last_transfusion_date else None,
                        "expected_next_transfusion_date": p.expected_next_transfusion_date.isoformat() if p.expected_next_transfusion_date else None,
                        "status": p.status,
                    }
                    for p in patients
                ]
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/patients/all")
async def get_all_patients(session: AsyncSession = Depends(get_db)):
    """
    Get all patients for selection dropdown
    """
    try:
        result = await session.execute(select(Patient))
        patients = result.scalars().all()
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(patients),
                "patients": [
                    {
                        "patient_id": p.patient_id,
                        "blood_group": p.blood_group,
                        "expected_next_transfusion_date": p.expected_next_transfusion_date.isoformat() if p.expected_next_transfusion_date else None,
                        "frequency_in_days": p.frequency_in_days,
                    }
                    for p in patients
                ]
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/patients/{patient_id}")
async def get_patient(patient_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get full patient profile
    """
    try:
        patient_id = unquote(patient_id)
        result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = result.scalars().first()
        
        if not patient:
            return JSONResponse(
                status_code=404,
                content={"success": False, "error": "Patient not found"}
            )
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "patient": {
                    "patient_id": patient.patient_id,
                    "blood_group": patient.blood_group,
                    "gender": patient.gender,
                    "latitude": patient.latitude,
                    "longitude": patient.longitude,
                    "quantity_required": patient.quantity_required,
                    "frequency_in_days": patient.frequency_in_days,
                    "last_transfusion_date": patient.last_transfusion_date.isoformat() if patient.last_transfusion_date else None,
                    "expected_next_transfusion_date": patient.expected_next_transfusion_date.isoformat() if patient.expected_next_transfusion_date else None,
                    "status": patient.status,
                    "registration_date": patient.registration_date.isoformat() if patient.registration_date else None,
                }
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================================
# BRIDGE ENDPOINTS
# ============================================================================

@app.get("/bridges")
async def list_bridges(
    bridge_id: Optional[str] = Query(None),
    patient_id: Optional[str] = Query(None),
    donor_id: Optional[str] = Query(None),
    limit: int = Query(default=50, le=10000),
    session: AsyncSession = Depends(get_db)
):
    """
    Get filtered bridge relationships
    
    Query parameters:
    - bridge_id: Filter by bridge ID
    - patient_id: Filter by patient ID
    - donor_id: Filter by donor ID
    - limit: Number of results (default 50, max 1000)
    """
    try:
        query = select(Bridge)
        
        if bridge_id:
            query = query.where(Bridge.bridge_id == bridge_id)
        if patient_id:
            query = query.where(Bridge.patient_id == patient_id)
        if donor_id:
            query = query.where(Bridge.donor_id == donor_id)
        
        query = query.limit(limit)
        result = await session.execute(query)
        bridges = result.scalars().all()
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(bridges),
                "bridges": [
                    {
                        "id": b.id,
                        "bridge_id": b.bridge_id,
                        "donor_id": b.donor_id,
                        "patient_id": b.patient_id,
                        "donations_till_date": b.donations_till_date,
                        "chain_position": b.chain_position,
                        "status_of_bridge": b.status_of_bridge,
                        "bridge_blood_group": b.bridge_blood_group,
                    }
                    for b in bridges
                ]
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================================
# ESCALATION POOL ENDPOINTS
# ============================================================================

@app.get("/escalation-pool/{patient_id}")
async def get_escalation_pool(
    patient_id: str,
    session: AsyncSession = Depends(get_db)
):
    """
    Get all donors in escalation pool for a patient, grouped by stage
    """
    try:
        patient_id = unquote(patient_id)
        result = await session.execute(
            select(EscalationPool).where(EscalationPool.patient_id == patient_id)
        )
        pool_entries = result.scalars().all()
        
        if not pool_entries:
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "patient_id": patient_id,
                    "stage_1": [],
                    "stage_2": [],
                    "stage_3": [],
                }
            )
        
        # Group by stage
        stages = {1: [], 2: [], 3: []}
        for entry in pool_entries:
            if entry.pool_stage in stages:
                stages[entry.pool_stage].append({
                    "donor_id": entry.donor_id,
                    "blood_group": entry.blood_group,
                    "added_at": entry.added_at.isoformat() if entry.added_at else None,
                })
        
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "patient_id": patient_id,
                "stage_1_bridge_donors": stages[1],
                "stage_2_emergency_donors": stages[2],
                "stage_3_all_active_donors": stages[3],
                "total_donors_in_pool": len(pool_entries),
            }
        )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@app.get("/eligible/{patient_id}")
async def eligible_donors(
    patient_id: str,
    required_date: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db)
):
    """Get eligible donors for a patient, optionally filtered by required date."""
    try:
        patient_id = unquote(patient_id)
        start = perf_counter()
        parsed_date = None
        if required_date:
            try:
                parsed_date = date.fromisoformat(required_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="required_date must be YYYY-MM-DD")

        helper_start = perf_counter()
        donors, counts = await get_eligible_donors(patient_id, parsed_date, session=session)
        helper_ms = (perf_counter() - helper_start) * 1000
        serialization_start = perf_counter()
        grouped: dict = {}
        for donor in donors:
            grouped.setdefault(donor["donor_category"], []).append(donor)

        payload = JSONResponse(
            status_code=200,
            content={
                "success": True,
                "patient_id": patient_id,
                "required_date": parsed_date.isoformat() if parsed_date else date.today().isoformat(),
                "total_eligible_count": len(donors),
                "counts_by_category": counts,
                "donors_by_category": grouped,
            }
        )
        logger.info(
            "[perf] eligible_donors endpoint helper_ms=%.2f serialization_ms=%.2f total_ms=%.2f patient_id=%s count=%d",
            helper_ms,
            (perf_counter() - serialization_start) * 1000,
            (perf_counter() - start) * 1000,
            patient_id,
            len(donors),
        )
        return payload
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/ranked/{patient_id}")
async def ranked_donors(
    patient_id: str,
    required_date: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db)
):
    patient_id = unquote(patient_id)
    """Get ranked eligible donors for a patient with score breakdown."""
    try:
        start = perf_counter()
        parsed_date = None
        if required_date:
            try:
                parsed_date = date.fromisoformat(required_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="required_date must be YYYY-MM-DD")

        helper_start = perf_counter()
        eligible, counts = await get_eligible_donors(patient_id, parsed_date, session=session)
        donor_ids = [item["donor_id"] for item in eligible]
        ranked = await rank_donors(patient_id, donor_ids, session=session)
        helper_ms = (perf_counter() - helper_start) * 1000
        serialization_start = perf_counter()

        payload = JSONResponse(
            status_code=200,
            content={
                "success": True,
                "patient_id": patient_id,
                "required_date": parsed_date.isoformat() if parsed_date else date.today().isoformat(),
                "total_eligible_count": len(donor_ids),
                "top_5": ranked[:5],
                "ranked_donors": ranked,
                "counts_by_category": counts,
            }
        )
        logger.info(
            "[perf] ranked_donors endpoint helper_ms=%.2f serialization_ms=%.2f total_ms=%.2f patient_id=%s eligible_count=%d ranked_count=%d",
            helper_ms,
            (perf_counter() - serialization_start) * 1000,
            (perf_counter() - start) * 1000,
            patient_id,
            len(eligible),
            len(ranked),
        )
        return payload
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/schedule/trigger")
async def trigger_schedule_scan():
    """Manually trigger a scheduler scan for all active patients."""
    try:
        summary = await run_scheduler_scan()
        return JSONResponse(status_code=200, content={"success": True, "summary": summary})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/schedule/status")
async def schedule_status():
    """Get current escalation status for active patients."""
    try:
        status = await get_schedule_status()
        return JSONResponse(status_code=200, content={"success": True, **status})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


async def _get_workflow_stage(patient_id: str):
    """Look up the current escalation stage and timing for one patient."""
    schedule = await get_schedule_status()
    for patient in schedule.get("active_patients", []):
        if patient.get("patient_id") == patient_id:
            return patient
    return None


@app.post("/workflow/trigger/{patient_id}")
async def trigger_workflow_endpoint(patient_id: str):
    """Queue the escalation workflow for one patient using the current scheduler stage."""
    try:
        patient_id = unquote(patient_id)
        patient_stage = await _get_workflow_stage(patient_id)
        if not patient_stage or patient_stage.get("escalation_stage") is None:
            raise HTTPException(status_code=404, detail="Patient is not in an active workflow stage")

        stage = patient_stage["escalation_stage"]
        days_until = patient_stage["days_until_transfusion"]
        task = trigger_escalation_workflow.delay(patient_id, stage, days_until)
        return JSONResponse(
            status_code=200,
            content={
                "task_id": task.id,
                "patient_id": patient_id,
                "stage": stage,
                "status": "queued",
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/workflow/status/{task_id}")
async def workflow_status(task_id: str):
    """Return the current Celery task status and result when available."""
    try:
        result = AsyncResult(task_id, app=celery_app)
        payload = {
            "task_id": task_id,
            "status": result.status,
        }
        if result.ready():
            payload["result"] = result.result
        return JSONResponse(status_code=200, content=payload)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/workflow/scan")
async def workflow_scan():
    """Queue the daily patient scan as a Celery task."""
    try:
        task = run_daily_scan.delay()
        return JSONResponse(
            status_code=200,
            content={
                "task_id": task.id,
                "status": "queued",
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/learning-log")
async def learning_log(
    patient_id: Optional[str] = Query(None),
    limit: int = Query(default=50, le=10000),
    session: AsyncSession = Depends(get_db),
):
    """Return the most recent learning log entries with an optional patient filter."""
    try:
        query = select(LearningLog)
        if patient_id:
            query = query.where(LearningLog.patient_id == patient_id)
        query = query.order_by(LearningLog.cycle_date.desc().nullslast()).limit(limit)
        result = await session.execute(query)
        rows = result.scalars().all()
        entries = [
            {
                "id": row.id,
                "cycle_date": row.cycle_date.isoformat() if row.cycle_date else None,
                "patient_id": row.patient_id,
                "stages_needed": row.stages_needed,
                "donors_contacted": row.donors_contacted,
                "donors_responded": row.donors_responded,
                "donors_donated": row.donors_donated,
                "pattern_notes": row.pattern_notes,
            }
            for row in rows
        ]
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(entries),
                "learning_log": entries,
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/admin/alert")
async def admin_alert(payload: AdminAlertRequest, session: AsyncSession = Depends(get_db)):
    """Log an admin alert into the escalation history for a patient."""
    try:
        alert = EscalationLog(
            patient_id=payload.patient_id,
            bridge_id=None,
            trigger_date=datetime.utcnow(),
            stage=None,
            action_taken="admin_alert",
            outcome=payload.message,
        )
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
        return JSONResponse(
            status_code=200,
            content={
                "logged": True,
                "patient_id": payload.patient_id,
                "message": payload.message,
                "id": alert.id,
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class AdminEmergencyRequest(BaseModel):
    patient_id: str
    donor_id: Optional[str] = None
    message: Optional[str] = "emergency_declared"


@app.post("/admin-alert")
async def admin_alert_emergency(payload: AdminEmergencyRequest, session: AsyncSession = Depends(get_db)):
    """Log an emergency escalation event for patient and donor."""
    try:
        alert = EscalationLog(
            patient_id=payload.patient_id,
            bridge_id=None,
            donor_id=payload.donor_id if hasattr(EscalationLog, 'donor_id') else None,
            trigger_date=datetime.utcnow(),
            stage=None,
            action_taken="emergency_declared",
            outcome=payload.message or "Emergency declared by coordinator",
        )
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
        return JSONResponse(status_code=200, content={"logged": True, "id": alert.id, "patient_id": payload.patient_id, "donor_id": payload.donor_id})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class PatientEmergencyRequest(BaseModel):
    required_date: Optional[str] = None
    reason: Optional[str] = "urgent_blood_need"


@app.post("/emergency/{patient_id}")
async def declare_emergency_endpoint(
    patient_id: str,
    payload: PatientEmergencyRequest,
    session: AsyncSession = Depends(get_db)
):
    """Log an emergency escalation event from the patient portal."""
    try:
        patient_id = unquote(patient_id)
        patient_result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = patient_result.scalars().first()
        if not patient:
            raise HTTPException(status_code=404, detail="Patient not found")

        alert = EscalationLog(
            patient_id=patient_id,
            bridge_id=None,
            trigger_date=datetime.utcnow(),
            stage=None,
            action_taken="emergency_declared",
            outcome=payload.reason or "Emergency declared by patient",
        )
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
        return JSONResponse(status_code=200, content={"success": True, "logged": True, "id": alert.id})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/emergency/resolve/{patient_id}")
async def resolve_emergency_endpoint(
    patient_id: str,
    session: AsyncSession = Depends(get_db)
):
    """Mark an active emergency as resolved for a patient (coordinator action)."""
    try:
        patient_id = unquote(patient_id)
        patient_result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = patient_result.scalars().first()
        if not patient:
            raise HTTPException(status_code=404, detail="Patient not found")

        resolution = EscalationLog(
            patient_id=patient_id,
            bridge_id=None,
            trigger_date=datetime.utcnow(),
            stage=None,
            action_taken="emergency_resolved",
            outcome="Emergency resolved by coordinator",
        )
        session.add(resolution)
        await session.commit()
        await session.refresh(resolution)
        return JSONResponse(status_code=200, content={"success": True, "resolved": True, "id": resolution.id})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/emergency/active")
async def get_active_emergencies(
    session: AsyncSession = Depends(get_db)
):
    """Return all patients with an active (unresolved) emergency declaration."""
    try:
        # Get all emergency_declared and emergency_resolved logs, grouped by patient
        result = await session.execute(
            select(EscalationLog)
            .where(EscalationLog.action_taken.in_(["emergency_declared", "emergency_resolved"]))
            .order_by(EscalationLog.trigger_date.desc())
        )
        logs = result.scalars().all()

        # For each patient, check if most recent relevant event is emergency_declared
        latest_by_patient = {}
        for log in logs:
            pid = log.patient_id
            if pid not in latest_by_patient:
                latest_by_patient[pid] = log

        active = []
        for pid, log in latest_by_patient.items():
            if log.action_taken == "emergency_declared":
                active.append({
                    "patient_id": pid,
                    "log_id": log.id,
                    "reason": log.outcome,
                    "declared_at": log.trigger_date.isoformat() if log.trigger_date else None,
                })

        return JSONResponse(status_code=200, content={"success": True, "active_emergencies": active, "count": len(active)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/chat")
async def chat_endpoint(payload: ChatRequest, session: AsyncSession = Depends(get_db)):
    """Send one donor-patient chat message through the conversational agent."""
    try:
        # Block AI if a coordinator has taken over this conversation
        handoff_active = await is_handoff_open(payload.donor_id, payload.patient_id, session)
        if handoff_active:
            return JSONResponse(status_code=200, content={
                "blocked": True,
                "reason": "coordinator_in_session",
                "response": "A coordinator has joined this conversation and will respond to you shortly. Please wait.",
                "donor_id": payload.donor_id,
                "patient_id": payload.patient_id,
            })

        # All messages (including confirmations) flow through chat_agent().
        # Confirmation detection and notification creation are handled inside
        # agent.chat() via _is_confirmation() + _save_confirmation_notification().
        result = await chat_agent(
            payload.donor_id,
            payload.patient_id,
            payload.message,
            sender=payload.sender,
            session=session,
        )
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ── Coordinator Handoff Routes ────────────────────────────────────────────────

@app.get("/handoffs/pending")
async def get_pending_handoffs(session: AsyncSession = Depends(get_db)):
    """Return all open coordinator handoff alerts (uncertain donor responses)."""
    try:
        # Get all coordinator_handoff_needed rows
        needed_result = await session.execute(
            select(NotificationsLog)
            .where(NotificationsLog.notification_type == 'coordinator_handoff_needed')
            .order_by(NotificationsLog.sent_at.desc())
        )
        needed_rows = needed_result.scalars().all()

        # Get all coordinator_handoff_closed rows
        closed_result = await session.execute(
            select(NotificationsLog)
            .where(NotificationsLog.notification_type == 'coordinator_handoff_closed')
            .order_by(NotificationsLog.sent_at.desc())
        )
        closed_rows = closed_result.scalars().all()

        # Index closed by (donor_id, patient_id) -> latest closed_at
        closed_map = {}
        for row in closed_rows:
            key = (row.donor_id, row.patient_id)
            if key not in closed_map or row.sent_at > closed_map[key]:
                closed_map[key] = row.sent_at

        # Keep only the most recent handoff per donor+patient that is open
        seen = {}
        for row in needed_rows:
            key = (row.donor_id, row.patient_id)
            if key not in seen:
                seen[key] = row

        pending = []
        for (donor_id, patient_id), row in seen.items():
            closed_at = closed_map.get((donor_id, patient_id))
            if closed_at is None or row.sent_at > closed_at:
                pending.append({
                    "id": row.id,
                    "donor_id": donor_id,
                    "patient_id": patient_id,
                    "donor_message": row.response or "",
                    "flagged_at": row.sent_at.isoformat() if row.sent_at else None,
                    "message": row.message or "",
                })

        return JSONResponse(status_code=200, content={"success": True, "pending": pending, "count": len(pending)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class HandoffCloseRequest(BaseModel):
    donor_id: str
    patient_id: str


@app.post("/handoffs/close")
async def close_handoff(payload: HandoffCloseRequest, session: AsyncSession = Depends(get_db)):
    """Mark a coordinator handoff as closed so the AI can resume."""
    try:
        notif = NotificationsLog(
            donor_id=payload.donor_id,
            patient_id=payload.patient_id,
            message="Coordinator closed handoff session",
            notification_type="coordinator_handoff_closed",
            sent_at=datetime.utcnow(),
            channel="coordinator",
        )
        session.add(notif)
        await session.commit()
        return JSONResponse(status_code=200, content={"success": True, "closed": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class CoordinatorMessageRequest(BaseModel):
    donor_id: str
    patient_id: str
    message: str


@app.post("/coordinator/message")
async def coordinator_direct_message(payload: CoordinatorMessageRequest, session: AsyncSession = Depends(get_db)):
    """Send a direct coordinator message to a donor — bypasses AI entirely."""
    try:
        from memory import save_message
        await save_message(
            payload.donor_id,
            payload.patient_id,
            "coordinator",
            payload.message,
            "coordinator_message",
            session=session,
        )
        await session.commit()
        return JSONResponse(status_code=200, content={"success": True, "saved": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})




class DonationStartRequest(BaseModel):
    donor_id: str
    patient_id: str


@app.post("/donation/start")
async def donation_start(payload: DonationStartRequest, session: AsyncSession = Depends(get_db)):
    try:
        started = await start_interview(payload.donor_id, payload.patient_id, session=session)
        return JSONResponse(status_code=200, content={"started": True, "question": started.get('question'), "session_id": started.get('session_id')})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class DonationAnswerRequest(BaseModel):
    donor_id: str
    patient_id: str
    message: str


@app.post("/donation/next-question")
async def donation_next(payload: DonationAnswerRequest, session: AsyncSession = Depends(get_db)):
    try:
        resp = await answer_next(payload.donor_id, payload.patient_id, payload.message, session=session)
        # if finished, auto-submit
        if resp.get('finished'):
            submitted = await submit_interview(payload.donor_id, payload.patient_id, session=session)
            return JSONResponse(status_code=200, content={"finished": True, "submitted": submitted})
        return JSONResponse(status_code=200, content=resp)
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


class DonationSubmitRequest(BaseModel):
    donor_id: str
    patient_id: str


@app.post("/donation/submit")
async def donation_submit(payload: DonationSubmitRequest, session: AsyncSession = Depends(get_db)):
    try:
        submitted = await submit_interview(payload.donor_id, payload.patient_id, session=session)
        return JSONResponse(status_code=200, content=submitted)
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/outreach/{patient_id}/{stage}")
async def outreach_endpoint(
    patient_id: str,
    stage: int,
    payload: Optional[OutreachRequest] = Body(default=None),
    session: AsyncSession = Depends(get_db),
):
    """Generate and store outreach messages for donors in a patient's escalation pool."""
    try:
        if stage not in (1, 2, 3):
            raise HTTPException(status_code=400, detail="stage must be 1, 2, or 3")
        language_code = payload.language_code.lower() if payload and payload.language_code else "en"
        draft_only = payload.draft_only if payload else False

        # Get patient blood group for fallback queries
        patient_result = await session.execute(select(Patient).where(Patient.patient_id == patient_id))
        patient_obj = patient_result.scalars().first()
        patient_blood_group = patient_obj.blood_group if patient_obj else None

        donor_ids: List[str] = []
        if payload and payload.donor_id:
            donor_ids = [payload.donor_id]
        else:
            # Stage 1: pool_stage = 1 only (bridge donors)
            # Stage 2: pool_stage <= 2 (bridge + emergency)
            # Stage 3: pool_stage <= 3 (all eligible)
            if stage == 1:
                pool_filter = and_(
                    EscalationPool.patient_id == patient_id,
                    EscalationPool.pool_stage == 1,
                )
            else:
                pool_filter = and_(
                    EscalationPool.patient_id == patient_id,
                    EscalationPool.pool_stage <= stage,
                )

            pool_result = await session.execute(
                select(EscalationPool)
                .where(pool_filter)
                .order_by(EscalationPool.pool_stage.asc(), EscalationPool.id.asc())
            )
            pool_entries = pool_result.scalars().all()
            for entry in pool_entries:
                if entry.donor_id and entry.donor_id not in donor_ids:
                    donor_ids.append(entry.donor_id)

            # Fallback: if escalation pool is empty, query donors directly by blood group
            if not donor_ids and patient_blood_group:
                logger.info(f"Escalation pool empty for patient {patient_id} stage {stage} — using direct donor fallback")
                if stage == 1:
                    fallback_query = (
                        select(Donor)
                        .where(
                            and_(
                                Donor.donor_category == "Bridge Donor",
                                Donor.blood_group == patient_blood_group,
                                Donor.eligibility_status == "eligible",
                            )
                        )
                        .limit(10)
                    )
                elif stage == 2:
                    fallback_query = (
                        select(Donor)
                        .where(
                            and_(
                                Donor.donor_category.in_(["Bridge Donor", "Emergency Donor"]),
                                Donor.blood_group == patient_blood_group,
                                Donor.eligibility_status == "eligible",
                            )
                        )
                        .limit(25)
                    )
                else:
                    fallback_query = (
                        select(Donor)
                        .where(
                            and_(
                                Donor.blood_group == patient_blood_group,
                                Donor.eligibility_status == "eligible",
                            )
                        )
                        .limit(100)
                    )
                fallback_result = await session.execute(fallback_query)
                fallback_donors = fallback_result.scalars().all()
                donor_ids = [d.user_id for d in fallback_donors if d.user_id]

        sample_message = ""
        notifications_saved = 0

        if draft_only:
            if donor_ids:
                generated_message = await generate_outreach_message(
                    donor_ids[0],
                    patient_id,
                    stage,
                    session=session,
                )
                sample_message = translate_message(generated_message, language_code)
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "messages_generated": 0,
                    "donors_contacted": 0,
                    "notifications_saved": 0,
                    "sample_message": sample_message,
                    "patient_id": patient_id,
                    "stage": stage,
                    "draft_only": True,
                },
            )

        for donor_id in donor_ids:
            generated_message = await generate_outreach_message(
                donor_id,
                patient_id,
                stage,
                session=session,
            )
            final_message = translate_message(generated_message, language_code)

            notification = NotificationsLog(
                donor_id=donor_id,
                patient_id=patient_id,
                message=final_message,
                sent_at=datetime.utcnow(),
                channel="whatsapp_sim",
                notification_type=f"outreach_stage_{stage}",
            )
            session.add(notification)
            notifications_saved += 1
            if not sample_message:
                sample_message = final_message

        await session.commit()
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "stage": stage,
                "patient_id": patient_id,
                "donors_contacted": len(donor_ids),
                "notifications_saved": notifications_saved,
                "sample_message": sample_message,
                "messages_generated": len(donor_ids),
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Outreach endpoint error for patient {patient_id} stage {stage}")
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/notifications-log")
async def get_notifications_log(
    donor_id: Optional[str] = Query(None),
    patient_id: Optional[str] = Query(None),
    notification_type: Optional[str] = Query(None),
    limit: int = Query(default=100, le=1000),
    session: AsyncSession = Depends(get_db),
):
    """
    Retrieve notification log entries filtered by donor, patient, or type.
    """
    try:
        query = select(NotificationsLog)
        if donor_id:
            query = query.where(NotificationsLog.donor_id == donor_id)
        if patient_id:
            query = query.where(NotificationsLog.patient_id == patient_id)
        if notification_type:
            query = query.where(NotificationsLog.notification_type == notification_type)
        query = query.order_by(NotificationsLog.sent_at.desc()).limit(limit)

        result = await session.execute(query)
        entries = result.scalars().all()
        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(entries),
                "notifications": [
                    {
                        "id": item.id,
                        "donor_id": item.donor_id,
                        "patient_id": item.patient_id,
                        "message": item.message,
                        "sent_at": item.sent_at.isoformat() if item.sent_at else None,
                        "response": item.response,
                        "responded_at": item.responded_at.isoformat() if item.responded_at else None,
                        "channel": item.channel,
                        "notification_type": item.notification_type,
                    }
                    for item in entries
                ],
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/sonar/{patient_id}")
async def sonar_endpoint(patient_id: str, session: AsyncSession = Depends(get_db)):
    """Broadcast a location check to every eligible donor for a patient."""
    try:
        patient_id = unquote(patient_id)
        patient_result = await session.execute(
            select(Patient).where(Patient.patient_id == patient_id)
        )
        patient = patient_result.scalars().first()
        if not patient:
            raise HTTPException(status_code=404, detail="Patient not found")

        eligible_donors, _ = await get_eligible_donors(patient_id, session=session)
        donor_ids = [donor["donor_id"] for donor in eligible_donors if donor.get("donor_id")]
        city_name = getattr(patient, "city_name", None) or "the city"

        result = await send_sonar_ping(
            patient_id=patient_id,
            donor_ids=donor_ids,
            city_name=city_name,
            session=session,
        )
        return JSONResponse(
            status_code=200,
            content={
                "pings_sent": result.get("pings_sent", 0),
                "notification_ids_sample": result.get("notification_ids_sample", []),
                "patient_id": patient_id,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/sonar/respond")
async def sonar_respond_endpoint(
    payload: SonarRespondRequest,
    session: AsyncSession = Depends(get_db),
):
    """Record a donor's response to a sonar ping."""
    try:
        result = await process_sonar_response(
            payload.notification_id,
            payload.response,
            session=session,
        )
        return JSONResponse(status_code=200, content=result)
    except ValueError as e:
        return JSONResponse(status_code=404, content={"error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/sonar/results/{patient_id}")
async def sonar_results_endpoint(patient_id: str, session: AsyncSession = Depends(get_db)):
    """Return a sonar summary for one patient."""
    try:
        patient_id = unquote(patient_id)
        result = await get_sonar_results(patient_id, session=session)
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


async def _fetch_conversation_history(
    donor_id: str,
    patient_id: Optional[str],
    caller: Optional[str],
    session: AsyncSession,
):
    """Fetch conversation rows for one donor with an optional patient filter."""
    query = select(ConversationHistory).where(ConversationHistory.donor_id == donor_id)
    if patient_id:
        query = query.where(ConversationHistory.patient_id == patient_id)
    query = query.order_by(ConversationHistory.timestamp.asc())
    result = await session.execute(query)
    rows = result.scalars().all()
    
    history = []
    for row in rows:
        db_role = row.role
        if caller == "donor":
            mapped_role = "user" if db_role in ("donor", "user") else "assistant"
        elif caller in ("coordinator", "patient"):
            mapped_role = "user" if db_role in ("coordinator", "patient", "assistant") else "assistant"
        else:
            mapped_role = "user" if db_role in ("donor", "user") else "assistant"
            
        history.append({
            "role": mapped_role,
            "message": row.message,
            "timestamp": row.timestamp.isoformat() if row.timestamp else None,
            "conversation_stage": row.conversation_stage,
            "patient_id": row.patient_id,
            "donor_id": row.donor_id,
        })
    return history


@app.get("/conversations/{donor_id}")
async def get_conversations_endpoint(
    donor_id: str,
    patient_id: Optional[str] = Query(None),
    caller: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    """Return stored conversation history for a donor, optionally for one patient."""
    try:
        history = await _fetch_conversation_history(donor_id, patient_id, caller, session)
        return JSONResponse(
            status_code=200,
            content={
                "donor_id": donor_id,
                "patient_id": patient_id,
                "history": history,
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/conversations")
async def get_conversations_query_endpoint(
    donor_id: str = Query(...),
    patient_id: Optional[str] = Query(None),
    caller: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    """Return stored conversation history for a donor using query parameters."""
    try:
        history = await _fetch_conversation_history(donor_id, patient_id, caller, session)
        return JSONResponse(
            status_code=200,
            content={
                "donor_id": donor_id,
                "patient_id": patient_id,
                "history": history,
            },
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/conversations/clear")
async def clear_conversations_endpoint(
    payload: ClearConversationRequest,
    session: AsyncSession = Depends(get_db),
):
    """Delete all stored conversation history for one donor-patient pair."""
    try:
        cleared_count = await clear_conversation(
            payload.donor_id,
            payload.patient_id,
            session=session,
        )
        return JSONResponse(status_code=200, content={"cleared_count": cleared_count})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/conversations/save")
async def save_conversation_message_endpoint(
    payload: SaveMessageRequest,
    session: AsyncSession = Depends(get_db),
):
    """Save a message directly to conversation history without calling AI."""
    try:
        record = ConversationHistory(
            donor_id=payload.donor_id,
            patient_id=payload.patient_id,
            role=payload.role,
            message=payload.message,
            timestamp=datetime.utcnow(),
            conversation_stage="coordinator_message",
        )
        session.add(record)
        await session.commit()
        return JSONResponse(status_code=200, content={"success": True, "saved": True})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/notify-donor")
async def notify_donor_endpoint(
    payload: NotifyDonorRequest,
    session: AsyncSession = Depends(get_db),
):
    """Create a manual outreach notification entry in notifications_log."""
    try:
        notif = NotificationsLog(
            donor_id=payload.donor_id,
            patient_id=payload.patient_id,
            message=payload.message,
            sent_at=datetime.utcnow(),
            channel="whatsapp_sim",
            notification_type=f"outreach_stage_{payload.stage}",
        )
        session.add(notif)
        await session.commit()
        await session.refresh(notif)
        return JSONResponse(status_code=200, content={"success": True, "notification_id": notif.id})
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.get("/escalation-log")
async def escalation_log(
    patient_id: Optional[str] = Query(None),
    stage: Optional[int] = Query(None, ge=1, le=3),
    limit: int = Query(default=50, le=10000),
    session: AsyncSession = Depends(get_db)
):
    """Get escalation history with optional filters."""
    try:
        query = select(EscalationLog)
        if patient_id:
            query = query.where(EscalationLog.patient_id == patient_id)
        if stage is not None:
            query = query.where(EscalationLog.stage == stage)
        query = query.order_by(EscalationLog.trigger_date.desc()).limit(limit)

        result = await session.execute(query)
        entries = result.scalars().all()

        return JSONResponse(
            status_code=200,
            content={
                "success": True,
                "count": len(entries),
                "entries": [
                    {
                        "id": item.id,
                        "patient_id": item.patient_id,
                        "stage": item.stage,
                        "action_taken": item.action_taken,
                        "outcome": item.outcome,
                        "trigger_date": item.trigger_date.isoformat() if item.trigger_date else None,
                    }
                    for item in entries
                ],
            }
        )
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/reserve")
async def reserve(
    donor_id: str = Body(...),
    patient_id: str = Body(...),
    transfusion_date: str = Body(...),
    session: AsyncSession = Depends(get_db)
):
    """Reserve a donor for a patient on a specified transfusion date."""
    try:
        reservation = await reserve_donor(donor_id, patient_id, transfusion_date, session=session)
        return JSONResponse(status_code=200, content={"success": True, "reservation": reservation})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"success": False, "error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/confirm")
async def confirm(reservation_id: int = Body(...), session: AsyncSession = Depends(get_db)):
    """Confirm a reservation and mark the donor donation as completed."""
    try:
        result = await confirm_reservation(reservation_id, session=session)
        return JSONResponse(status_code=200, content={"success": True, "result": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"success": False, "error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.post("/release")
async def release(reservation_id: int = Body(...), session: AsyncSession = Depends(get_db)):
    """Release a donor reservation and restore eligibility."""
    try:
        result = await release_reservation(reservation_id, session=session)
        return JSONResponse(status_code=200, content={"success": True, "result": result})
    except ValueError as e:
        return JSONResponse(status_code=400, content={"success": False, "error": str(e)})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


@app.get("/reservations")
async def reservations(
    patient_id: Optional[str] = Query(None),
    donor_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db)
):
    """Get reservations filtered by patient, donor, or status."""
    try:
        records = await list_reservations(patient_id, donor_id, status, session=session)
        return JSONResponse(status_code=200, content={"success": True, "count": len(records), "reservations": records})
    except Exception as e:
        return JSONResponse(status_code=500, content={"success": False, "error": str(e)})


# ============================================================================
# INGEST ENDPOINT
# ============================================================================

@app.post("/ingest")
async def trigger_ingest():
    """
    Trigger ingestion of CSV data programmatically
    
    This endpoint runs the complete data ingestion pipeline:
    1. Reads CSV from DATASET_PATH or current directory
    2. Processes patients, donors, and bridge relationships
    3. Populates escalation pools
    4. Creates Neo4j graph
    
    Returns summary of what was inserted
    """
    try:
        result = await ingest_data()
        
        if result.get("success"):
            return JSONResponse(
                status_code=200,
                content={
                    "success": True,
                    "message": "Ingestion completed successfully",
                    "summary": {
                        "patients_inserted": result.get("patients_inserted"),
                        "donors_inserted": result.get("donors_by_category"),
                        "bridges_created": result.get("bridges_created"),
                        "bridges_skipped": result.get("bridges_skipped"),
                        "escalation_pool": {
                            "stage_1": result.get("escalation_pool_stage_1"),
                            "stage_2": result.get("escalation_pool_stage_2"),
                            "stage_3": result.get("escalation_pool_stage_3"),
                        },
                        "neo4j": {
                            "nodes_created": result.get("neo4j_nodes"),
                            "edges_created": result.get("neo4j_edges"),
                        }
                    }
                }
            )
        else:
            return JSONResponse(
                status_code=500,
                content={
                    "success": False,
                    "error": result.get("error", "Ingestion failed")
                }
            )
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


# ============================================================================
# ROOT ENDPOINT
# ============================================================================

@app.get("/")
async def root():
    """
    API root endpoint with basic information
    """
    return JSONResponse(
        status_code=200,
        content={
            "success": True,
            "application": "IDMS - Intelligent Donation Management System",
            "version": "1.0.0",
            "description": "AI-powered wrapper layer over Blood Warriors Foundation's blood donation platform",
            "endpoints": {
                "health": "/health",
                "donors": "/donors, /donors/{donor_id}",
                "patients": "/patients, /patients/{patient_id}",
                "bridges": "/bridges",
                "escalation_pool": "/escalation-pool/{patient_id}",
                "eligible": "/eligible/{patient_id}",
                "ranked": "/ranked/{patient_id}",
                "schedule_trigger": "/schedule/trigger (POST)",
                "schedule_status": "/schedule/status",
                "workflow_trigger": "/workflow/trigger/{patient_id} (POST)",
                "workflow_status": "/workflow/status/{task_id}",
                "workflow_scan": "/workflow/scan (POST)",
                "learning_log": "/learning-log",
                "admin_alert": "/admin/alert (POST)",
                "chat": "/chat (POST)",
                "outreach": "/outreach/{patient_id}/{stage} (POST)",
                "sonar": "/sonar/{patient_id} (POST)",
                "sonar_respond": "/sonar/respond (POST)",
                "sonar_results": "/sonar/results/{patient_id}",
                "conversations": "/conversations/{donor_id}",
                "conversations_clear": "/conversations/clear (POST)",
                "escalation_log": "/escalation-log",
                "reservations": "/reservations",
                "reserve": "/reserve (POST)",
                "confirm": "/confirm (POST)",
                "release": "/release (POST)",
                "ingest": "/ingest (POST)",
            }
        }
    )
