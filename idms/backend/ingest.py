import os
import sys
import pandas as pd
from datetime import datetime, timedelta
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlalchemy import text, select, func, and_
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def find_dataset():
    """Find CSV file from DATASET_PATH or current directory"""
    dataset_path = os.getenv("DATASET_PATH")
    
    if dataset_path and os.path.exists(dataset_path):
        logger.info(f"Using dataset from DATASET_PATH: {dataset_path}")
        return dataset_path
    
    # Search for CSV in current directory
    current_dir = Path.cwd()
    csv_files = list(current_dir.glob("*.csv"))
    
    if csv_files:
        dataset_path = str(csv_files[0])
        logger.info(f"Found dataset: {dataset_path}")
        return dataset_path
    
    # Search in parent directories
    for parent_dir in current_dir.parents:
        csv_files = list(parent_dir.glob("*.csv"))
        if csv_files:
            dataset_path = str(csv_files[0])
            logger.info(f"Found dataset: {dataset_path}")
            return dataset_path
    
    raise FileNotFoundError("Dataset CSV not found. Set DATASET_PATH or place CSV in project directory.")


def normalize_reliability_score(total_calls, donations_till_date):
    """Normalize calls_to_donations_ratio to 0-1 scale"""
    total_calls = total_calls or 0
    donations_till_date = donations_till_date or 0
    
    if total_calls > 0 and donations_till_date is not None:
        score = min(1.0, donations_till_date / total_calls)
    elif donations_till_date and donations_till_date > 0:
        score = 0.8
    else:
        score = 0.0
    
    return score


def parse_timestamp(value):
    """Safely parse timestamp"""
    if pd.isna(value) or value is None:
        return None
    try:
        if isinstance(value, str):
            return pd.to_datetime(value)
        return value
    except:
        return None


async def ingest_data():
    """Main ingestion function"""
    # Import here to avoid circular imports
    from models import Base, Donor, Patient, Bridge, EscalationPool
    
    try:
        from neo4j import GraphDatabase
    except ImportError:
        logger.warning("Neo4j driver not available")
        GraphDatabase = None
    
    # Get database credentials from environment variables
    POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
    POSTGRES_PORT = os.getenv("POSTGRES_PORT", "5432")
    POSTGRES_DB = os.getenv("POSTGRES_DB", "idms")
    POSTGRES_USER = os.getenv("POSTGRES_USER", "postgres")
    POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "postgres")
    
    NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
    NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "password")
    
    DATABASE_URL = f"postgresql+asyncpg://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"
    
    logger.info("=" * 80)
    logger.info("IDMS DATA INGESTION STARTED")
    logger.info("=" * 80)
    
    try:
        # Find and load dataset
        dataset_path = find_dataset()
        logger.info(f"Loading dataset from: {dataset_path}")
        df = pd.read_csv(dataset_path)
        # Replace NaN values with None so they're inserted as NULL in the database
        df = df.where(pd.notna(df), None)
        logger.info(f"Dataset loaded: {len(df)} rows, {len(df.columns)} columns")
        
        # Create async engine
        engine = create_async_engine(
            DATABASE_URL,
            echo=False,
            connect_args={"timeout": 10}
        )
        
        async_session = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        
        # Create tables
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        logger.info("Database schema initialized")
        
        # Process data
        patients_inserted = 0
        donors_by_category = {}
        bridges_created = 0
        bridges_skipped = 0
        escalation_stage_counts = {1: 0, 2: 0, 3: 0}
        
        # Separate data by role
        logger.info("\n" + "=" * 80)
        logger.info("STEP 1: PROCESSING PATIENTS")
        logger.info("=" * 80)
        
        async with async_session() as session:
            patient_rows = df[df['role'] == 'Patient']
            logger.info(f"Found {len(patient_rows)} patient rows")
            
            for _, row in patient_rows.iterrows():
                try:
                    patient_id = row.get('user_id')
                    if not patient_id:
                        continue
                    
                    # Recalculate expected_next_transfusion_date
                    last_transfusion = parse_timestamp(row.get('last_transfusion_date'))
                    frequency = row.get('frequency_in_days')
                    frequency = frequency if pd.notna(frequency) and frequency > 0 else 21
                    
                    if last_transfusion:
                        expected_next = last_transfusion + timedelta(days=int(frequency))
                    else:
                        expected_next = datetime.utcnow() + timedelta(days=21)
                    
                    patient = Patient(
                        patient_id=patient_id,
                        blood_group=row.get('blood_group'),
                        gender=row.get('gender'),
                        latitude=row.get('latitude') if pd.notna(row.get('latitude')) else None,
                        longitude=row.get('longitude') if pd.notna(row.get('longitude')) else None,
                        quantity_required=int(row.get('quantity_required', 1)) if pd.notna(row.get('quantity_required')) else 1,
                        frequency_in_days=int(frequency),
                        last_transfusion_date=last_transfusion,
                        expected_next_transfusion_date=expected_next,
                        status=row.get('status', 'active'),
                        registration_date=parse_timestamp(row.get('registration_date')),
                    )
                    await session.merge(patient)
                    patients_inserted += 1
                    
                except Exception as e:
                    logger.warning(f"Failed to process patient {row.get('user_id')}: {str(e)}")
            
            await session.commit()
            logger.info(f"✓ Patients inserted: {patients_inserted}")
        
        # Process donors
        logger.info("\n" + "=" * 80)
        logger.info("STEP 2: PROCESSING DONORS")
        logger.info("=" * 80)
        
        donor_roles = {
            'Bridge Donor': 'Bridge Donor',
            'Emergency Donor': 'Emergency Donor',
            'Guest': 'Guest',
            'Volunteer': 'Volunteer'
        }
        
        async with async_session() as session:
            for role, category in donor_roles.items():
                donor_rows = df[df['role'] == role]
                logger.info(f"Found {len(donor_rows)} {role} rows")
                donors_by_category[category] = 0
                
                for _, row in donor_rows.iterrows():
                    try:
                        user_id = row.get('user_id')
                        if not user_id:
                            continue
                        
                        # Normalize reliability score
                        total_calls = row.get('total_calls')
                        total_calls = int(total_calls) if pd.notna(total_calls) else 0
                        donations_till = row.get('donations_till_date')
                        donations_till = int(donations_till) if pd.notna(donations_till) else 0
                        
                        normalized_score = normalize_reliability_score(total_calls, donations_till)
                        
                        # Set frequency_in_days for non-bridge donors to 0
                        frequency = row.get('frequency_in_days')
                        if category != 'Bridge Donor':
                            frequency = 0
                        else:
                            frequency = int(frequency) if pd.notna(frequency) and frequency > 0 else 0
                        
                        donor = Donor(
                            user_id=user_id,
                            blood_group=row.get('blood_group'),
                            gender=row.get('gender'),
                            latitude=row.get('latitude') if pd.notna(row.get('latitude')) else None,
                            longitude=row.get('longitude') if pd.notna(row.get('longitude')) else None,
                            last_donation_date=parse_timestamp(row.get('last_donation_date')),
                            next_eligible_date=parse_timestamp(row.get('next_eligible_date')),
                            donations_till_date=donations_till,
                            eligibility_status=row.get('eligibility_status'),
                            total_calls=total_calls,
                            calls_to_donations_ratio=row.get('calls_to_donations_ratio'),
                            normalized_reliability_score=normalized_score,
                            user_donation_active_status=row.get('user_donation_active_status'),
                            inactive_trigger_comment=row.get('inactive_trigger_comment'),
                            registration_date=parse_timestamp(row.get('registration_date')),
                            last_contacted_date=parse_timestamp(row.get('last_contacted_date')),
                            donor_type=row.get('donor_type'),
                            donor_category=category,
                            cycle_of_donations=int(row.get('cycle_of_donations')) if pd.notna(row.get('cycle_of_donations')) else None,
                            frequency_in_days=frequency,
                            status=row.get('status'),
                            donated_earlier=bool(row.get('donated_earlier')) if pd.notna(row.get('donated_earlier')) else False,
                            role_status=bool(row.get('role_status')) if pd.notna(row.get('role_status')) else False,
                        )
                        await session.merge(donor)
                        donors_by_category[category] += 1
                        
                    except Exception as e:
                        logger.warning(f"Failed to process {role} {row.get('user_id')}: {str(e)}")
                
                logger.info(f"✓ {category} donors inserted: {donors_by_category[category]}")
            
            await session.commit()
        
        # Process bridges
        logger.info("\n" + "=" * 80)
        logger.info("STEP 3: PROCESSING BRIDGES")
        logger.info("=" * 80)
        
        async with async_session() as session:
            bridge_rows = df[df['role'] == 'Bridge Donor']
            logger.info(f"Found {len(bridge_rows)} bridge donor rows to process")
            
            # Group by bridge_id to calculate chain_position
            for bridge_id, group in bridge_rows.groupby('bridge_id'):
                # Sort by donations_till_date DESC (with NULLs last)
                group = group.sort_values('donations_till_date', ascending=False, na_position='last')
                
                for chain_pos, (_, row) in enumerate(group.iterrows(), 1):
                    try:
                        donor_id = row.get('user_id')
                        bridge_blood_group = row.get('bridge_blood_group')
                        
                        if not donor_id or not bridge_blood_group:
                            continue
                        
                        # Find patient with matching blood group
                        patient_result = await session.execute(
                            select(Patient).where(Patient.blood_group == bridge_blood_group).limit(1)
                        )
                        patient = patient_result.scalars().first()
                        
                        if not patient:
                            bridges_skipped += 1
                            logger.warning(f"No patient found for bridge {bridge_id}, blood group {bridge_blood_group}")
                            continue
                        
                        bridge = Bridge(
                            bridge_id=bridge_id,
                            donor_id=donor_id,
                            patient_id=patient.patient_id,
                            donations_till_date=int(row.get('donations_till_date')) if pd.notna(row.get('donations_till_date')) else None,
                            last_bridge_donation_date=parse_timestamp(row.get('last_bridge_donation_date')),
                            status_of_bridge=bool(row.get('status_of_bridge')) if pd.notna(row.get('status_of_bridge')) else False,
                            role=row.get('role'),
                            role_status=bool(row.get('role_status')) if pd.notna(row.get('role_status')) else False,
                            bridge_blood_group=bridge_blood_group,
                            chain_position=chain_pos,
                        )
                        await session.merge(bridge)
                        bridges_created += 1
                        
                    except Exception as e:
                        logger.warning(f"Failed to process bridge {bridge_id}: {str(e)}")
            
            await session.commit()
            logger.info(f"✓ Bridges created: {bridges_created}")
            logger.info(f"✓ Bridge donors with no matching patient: {bridges_skipped}")
        
        # Populate escalation pool
        logger.info("\n" + "=" * 80)
        logger.info("STEP 4: POPULATING ESCALATION POOL")
        logger.info("=" * 80)
        
        async with async_session() as session:
            # Get all patients
            patients_result = await session.execute(select(Patient))
            patients = patients_result.scalars().all()
            logger.info(f"Processing escalation pool for {len(patients)} patients")
            
            for patient in patients:
                try:
                    added_donors = set()  # Track donors already added for this patient
                    
                    # Stage 1: Bridge Donors with matching blood group
                    stage1_result = await session.execute(
                        select(Bridge).where(
                            and_(
                                Bridge.patient_id == patient.patient_id,
                                Bridge.bridge_blood_group == patient.blood_group
                            )
                        )
                    )
                    stage1_bridges = stage1_result.scalars().all()
                    
                    for bridge in stage1_bridges:
                        try:
                            if bridge.donor_id in added_donors:
                                continue  # Skip if already added
                            pool = EscalationPool(
                                patient_id=patient.patient_id,
                                donor_id=bridge.donor_id,
                                pool_stage=1,
                                blood_group=patient.blood_group,
                            )
                            await session.merge(pool)
                            added_donors.add(bridge.donor_id)
                            escalation_stage_counts[1] += 1
                        except Exception as e:
                            pass  # Duplicate or other error
                    
                    # Stage 2: Emergency Donors with matching blood group and active status
                    stage2_result = await session.execute(
                        select(Donor).where(
                            and_(
                                Donor.blood_group == patient.blood_group,
                                Donor.donor_category == 'Emergency Donor',
                                Donor.donor_type == 'Regular Donor',
                                Donor.user_donation_active_status == 'Active'
                            )
                        )
                    )
                    stage2_donors = stage2_result.scalars().all()
                    
                    for donor in stage2_donors:
                        try:
                            if donor.user_id in added_donors:
                                continue  # Skip if already added
                            pool = EscalationPool(
                                patient_id=patient.patient_id,
                                donor_id=donor.user_id,
                                pool_stage=2,
                                blood_group=patient.blood_group,
                            )
                            await session.merge(pool)
                            added_donors.add(donor.user_id)
                            escalation_stage_counts[2] += 1
                        except Exception as e:
                            pass  # Duplicate or other error
                    
                    # Stage 3: All remaining active donors with matching blood group
                    stage3_result = await session.execute(
                        select(Donor).where(
                            and_(
                                Donor.blood_group == patient.blood_group,
                                Donor.user_donation_active_status == 'Active'
                            )
                        )
                    )
                    stage3_donors = stage3_result.scalars().all()
                    
                    for donor in stage3_donors:
                        try:
                            if donor.user_id in added_donors:
                                continue  # Skip if already added
                            pool = EscalationPool(
                                patient_id=patient.patient_id,
                                donor_id=donor.user_id,
                                pool_stage=3,
                                blood_group=patient.blood_group,
                            )
                            await session.merge(pool)
                            added_donors.add(donor.user_id)
                            escalation_stage_counts[3] += 1
                        except Exception as e:
                            pass  # Duplicate or other error
                    
                except Exception as e:
                    logger.warning(f"Failed to populate escalation pool for patient {patient.patient_id}: {str(e)}")
            
            await session.commit()
            logger.info(f"✓ Escalation pool - Stage 1: {escalation_stage_counts[1]}")
            logger.info(f"✓ Escalation pool - Stage 2: {escalation_stage_counts[2]}")
            logger.info(f"✓ Escalation pool - Stage 3: {escalation_stage_counts[3]}")
        
        # Create Neo4j graph
        logger.info("\n" + "=" * 80)
        logger.info("STEP 5: CREATING NEO4J GRAPH")
        logger.info("=" * 80)
        
        neo4j_nodes_created = 0
        neo4j_edges_created = 0
        
        try:
            if GraphDatabase is None:
                raise ImportError("Neo4j driver not available")
                
            driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
            
            async with async_session() as session:
                # Create patient nodes
                patients_result = await session.execute(select(Patient))
                patients = patients_result.scalars().all()
                
                with driver.session() as neo_session:
                    for patient in patients:
                        neo_session.run(
                            """
                            MERGE (p:Patient {patient_id: $patient_id})
                            SET p.blood_group = $blood_group,
                                p.frequency_in_days = $frequency_in_days,
                                p.expected_next_transfusion_date = $expected_next
                            """,
                            patient_id=patient.patient_id,
                            blood_group=patient.blood_group,
                            frequency_in_days=patient.frequency_in_days,
                            expected_next=patient.expected_next_transfusion_date.isoformat() if patient.expected_next_transfusion_date else None,
                        )
                        neo4j_nodes_created += 1
                    
                    logger.info(f"✓ Patient nodes created: {neo4j_nodes_created}")
                    
                    # Create donor nodes
                    donors_result = await session.execute(select(Donor))
                    donors = donors_result.scalars().all()
                    
                    donor_node_count = 0
                    for donor in donors:
                        neo_session.run(
                            """
                            MERGE (d:Donor {user_id: $user_id})
                            SET d.blood_group = $blood_group,
                                d.donor_category = $donor_category,
                                d.normalized_reliability_score = $score,
                                d.eligibility_status = $eligibility_status
                            """,
                            user_id=donor.user_id,
                            blood_group=donor.blood_group,
                            donor_category=donor.donor_category,
                            score=donor.normalized_reliability_score,
                            eligibility_status=donor.eligibility_status,
                        )
                        donor_node_count += 1
                    
                    neo4j_nodes_created += donor_node_count
                    logger.info(f"✓ Donor nodes created: {donor_node_count}")
                    
                    # Create DONATED_FOR edges
                    bridges_result = await session.execute(select(Bridge))
                    bridges = bridges_result.scalars().all()
                    
                    for bridge in bridges:
                        if bridge.donor_id and bridge.patient_id:
                            neo_session.run(
                                """
                                MATCH (d:Donor {user_id: $donor_id})
                                MATCH (p:Patient {patient_id: $patient_id})
                                MERGE (d)-[r:DONATED_FOR]->(p)
                                SET r.donation_count = $donation_count,
                                    r.last_donation_date = $last_donation_date,
                                    r.reliability_score = $reliability_score,
                                    r.chain_position = $chain_position,
                                    r.frequency_in_days = $frequency_in_days
                                """,
                                donor_id=bridge.donor_id,
                                patient_id=bridge.patient_id,
                                donation_count=bridge.donations_till_date,
                                last_donation_date=bridge.last_bridge_donation_date.isoformat() if bridge.last_bridge_donation_date else None,
                                reliability_score=0.0,  # This would come from the donor
                                chain_position=bridge.chain_position,
                                frequency_in_days=0,
                            )
                            neo4j_edges_created += 1
                    
                    logger.info(f"✓ DONATED_FOR edges created: {neo4j_edges_created}")
            
            driver.close()
        
        except Exception as e:
            logger.error(f"Neo4j graph creation failed: {str(e)}")
        
        # Print summary
        logger.info("\n" + "=" * 80)
        logger.info("INGESTION SUMMARY")
        logger.info("=" * 80)
        logger.info(f"✓ Patients inserted: {patients_inserted}")
        total_donors = sum(donors_by_category.values())
        logger.info(f"✓ Total donors inserted: {total_donors}")
        for category, count in donors_by_category.items():
            logger.info(f"  - {category}: {count}")
        logger.info(f"✓ Bridges created: {bridges_created}")
        logger.info(f"✓ Bridge donors with no matching patient (skipped): {bridges_skipped}")
        logger.info(f"✓ Escalation pool entries:")
        logger.info(f"  - Stage 1 (Bridge Donors): {escalation_stage_counts[1]}")
        logger.info(f"  - Stage 2 (Emergency Donors): {escalation_stage_counts[2]}")
        logger.info(f"  - Stage 3 (All Active): {escalation_stage_counts[3]}")
        logger.info(f"✓ Neo4j nodes created: {neo4j_nodes_created}")
        logger.info(f"✓ Neo4j edges created: {neo4j_edges_created}")
        logger.info("=" * 80)
        logger.info("INGESTION COMPLETED SUCCESSFULLY")
        logger.info("=" * 80)
        
        await engine.dispose()
        
        return {
            "success": True,
            "patients_inserted": patients_inserted,
            "donors_by_category": donors_by_category,
            "bridges_created": bridges_created,
            "bridges_skipped": bridges_skipped,
            "escalation_pool_stage_1": escalation_stage_counts[1],
            "escalation_pool_stage_2": escalation_stage_counts[2],
            "escalation_pool_stage_3": escalation_stage_counts[3],
            "neo4j_nodes": neo4j_nodes_created,
            "neo4j_edges": neo4j_edges_created,
        }
    
    except Exception as e:
        logger.error(f"Ingestion failed: {str(e)}")
        return {
            "success": False,
            "error": str(e),
        }


if __name__ == "__main__":
    import asyncio
    result = asyncio.run(ingest_data())
    sys.exit(0 if result.get("success") else 1)
