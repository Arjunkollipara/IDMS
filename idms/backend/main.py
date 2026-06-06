import os
import logging
from datetime import date, datetime
from typing import List, Optional
from fastapi import FastAPI, Depends, Query, HTTPException, Body
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from celery.result import AsyncResult
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, func
from contextlib import asynccontextmanager
import asyncio

# Import database and models
from database import get_db, check_db_connection, engine, async_session
from agent import chat as chat_agent
from celery_app import app as celery_app
from eligibility import get_eligible_donors
from ranking import rank_donors
from memory import clear_conversation
from outreach import generate_outreach_message, translate_message
from scheduler import scheduler, run_scheduler_scan, get_schedule_status
from reservation import reserve_donor, confirm_reservation, release_reservation, list_reservations
from sonar import get_sonar_results, process_sonar_response, send_sonar_ping
from models import (
    Base,
    Bridge,
    ConversationHistory,
    Donor,
    EscalationLog,
    EscalationPool,
    LearningLog,
    NotificationsLog,
    Patient,
    ReservationLog,
)
from ingest import ingest_data
from tasks.daily_scan import run_daily_scan
from tasks.escalation import trigger_escalation_workflow

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


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

    scheduler.start()
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
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    """Capture the data required to send one conversation message."""
    donor_id: str
    patient_id: str
    message: str


class OutreachRequest(BaseModel):
    """Capture the optional outreach language preference."""
    language_code: str = "en"


class SonarRespondRequest(BaseModel):
    """Capture a sonar response from a donor."""
    notification_id: int
    response: str


class ClearConversationRequest(BaseModel):
    """Capture the donor-patient pair whose history should be cleared."""
    donor_id: str
    patient_id: str


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


@app.get("/donors/{donor_id}")
async def get_donor(donor_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get full donor profile
    """
    try:
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


@app.get("/patients/{patient_id}")
async def get_patient(patient_id: str, session: AsyncSession = Depends(get_db)):
    """
    Get full patient profile
    """
    try:
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
        parsed_date = None
        if required_date:
            try:
                parsed_date = date.fromisoformat(required_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="required_date must be YYYY-MM-DD")

        donors, counts = await get_eligible_donors(patient_id, parsed_date, session=session)
        grouped: dict = {}
        for donor in donors:
            grouped.setdefault(donor["donor_category"], []).append(donor)

        return JSONResponse(
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
    """Get ranked eligible donors for a patient with score breakdown."""
    try:
        parsed_date = None
        if required_date:
            try:
                parsed_date = date.fromisoformat(required_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="required_date must be YYYY-MM-DD")

        eligible, counts = await get_eligible_donors(patient_id, parsed_date, session=session)
        donor_ids = [item["donor_id"] for item in eligible]
        ranked = await rank_donors(patient_id, donor_ids, session=session)

        return JSONResponse(
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


@app.post("/chat")
async def chat_endpoint(payload: ChatRequest, session: AsyncSession = Depends(get_db)):
    """Send one donor-patient chat message through the conversational agent."""
    try:
        result = await chat_agent(
            payload.donor_id,
            payload.patient_id,
            payload.message,
            session=session,
        )
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


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

        result = await session.execute(
            select(EscalationPool)
            .where(
                and_(
                    EscalationPool.patient_id == patient_id,
                    EscalationPool.pool_stage <= stage,
                )
            )
            .order_by(EscalationPool.pool_stage.asc(), EscalationPool.id.asc())
        )
        pool_entries = result.scalars().all()
        donor_ids: List[str] = []
        for entry in pool_entries:
            if entry.donor_id and entry.donor_id not in donor_ids:
                donor_ids.append(entry.donor_id)

        sample_message = ""
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
            if not sample_message:
                sample_message = final_message

        await session.commit()
        return JSONResponse(
            status_code=200,
            content={
                "messages_generated": len(donor_ids),
                "sample_message": sample_message,
                "patient_id": patient_id,
                "stage": stage,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


@app.post("/sonar/{patient_id}")
async def sonar_endpoint(patient_id: str, session: AsyncSession = Depends(get_db)):
    """Broadcast a location check to every eligible donor for a patient."""
    try:
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
        result = await get_sonar_results(patient_id, session=session)
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


async def _fetch_conversation_history(
    donor_id: str,
    patient_id: Optional[str],
    session: AsyncSession,
):
    """Fetch conversation rows for one donor with an optional patient filter."""
    query = select(ConversationHistory).where(ConversationHistory.donor_id == donor_id)
    if patient_id:
        query = query.where(ConversationHistory.patient_id == patient_id)
    query = query.order_by(ConversationHistory.timestamp.asc())
    result = await session.execute(query)
    rows = result.scalars().all()
    return [
        {
            "role": row.role,
            "message": row.message,
            "timestamp": row.timestamp.isoformat() if row.timestamp else None,
            "conversation_stage": row.conversation_stage,
            "patient_id": row.patient_id,
            "donor_id": row.donor_id,
        }
        for row in rows
    ]


@app.get("/conversations/{donor_id}")
async def get_conversations_endpoint(
    donor_id: str,
    patient_id: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db),
):
    """Return stored conversation history for a donor, optionally for one patient."""
    try:
        history = await _fetch_conversation_history(donor_id, patient_id, session)
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
    session: AsyncSession = Depends(get_db),
):
    """Return stored conversation history for a donor using query parameters."""
    try:
        history = await _fetch_conversation_history(donor_id, patient_id, session)
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
