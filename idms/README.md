# IDMS - Intelligent Donation Management System

**Intelligent Donation Management System**: An AI-powered wrapper layer over Blood Warriors Foundation's existing blood donation platform.

Blood Warriors connects voluntary blood donors with Thalassemia patients across India. Patients need blood every 2-3 weeks for life. We're building an intelligent layer on top of their existing data, not rebuilding their system—we read their data and make it smarter.

## Architecture

```
idms/
├── docker-compose.yml        # Services: PostgreSQL, Neo4j, Backend
├── .env                       # Environment variables
├── README.md                  # This file
└── backend/
    ├── main.py               # FastAPI application
    ├── schema.sql            # PostgreSQL schema
    ├── ingest.py             # CSV ingestion pipeline
    ├── models.py             # SQLAlchemy ORM models
    ├── database.py           # Async database setup
    ├── requirements.txt       # Python dependencies
    └── Dockerfile            # Backend container image
```

## Services

- **PostgreSQL**: Primary data store (port 5432)
- **Neo4j**: Graph database for relationship queries (port 7474 web, 7687 bolt)
- **Backend API**: FastAPI application (port 8000)

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Dataset.csv file in the project root

### Step 1: Set Environment Variables

Copy `.env` and update credentials:

```bash
cp .env .env.local
# Edit .env with your database passwords
```

### Step 2: Place Dataset

Put your `Dataset.csv` file in the project root or set `DATASET_PATH` in `.env`

### Step 3: Start Services

```bash
docker-compose up --build
```

This will:
- Create PostgreSQL database with schema
- Start Neo4j instance
- Build and start the backend API

### Step 4: Ingest Data

Once all services are healthy:

```bash
curl -X POST http://localhost:8000/ingest
```

This triggers the complete ingestion pipeline:
1. Reads CSV from `Dataset.csv`
2. Processes patients and donors
3. Creates bridge relationships
4. Populates escalation pools
5. Creates Neo4j graph

### Step 5: Verify

Check system health:

```bash
curl http://localhost:8000/health
```

Expected response:
```json
{
  "success": true,
  "status": "healthy",
  "api_status": "running",
  "database_status": "connected",
  "neo4j_status": "connected",
  "table_counts": {
    "donors": 5841,
    "patients": 84,
    "bridges": 786,
    "escalation_pool": 15234
  }
}
```

## API Endpoints

### Health & Info

- `GET /` - API information
- `GET /health` - System health check

### Donors

- `GET /donors` - List donors (paginated, filterable)
- `GET /donors/{donor_id}` - Get donor profile

Query parameters for `/donors`:
- `category` - Bridge Donor, Emergency Donor, Guest, Volunteer
- `blood_group` - Blood group (e.g., O+, A-, B+)
- `status` - user_donation_active_status
- `limit` - Results per page (default 50, max 1000)

Example:
```bash
curl "http://localhost:8000/donors?category=Bridge%20Donor&blood_group=O%2B&limit=10"
```

### Patients

- `GET /patients` - List patients (paginated, filterable)
- `GET /patients/{patient_id}` - Get patient profile

Query parameters for `/patients`:
- `blood_group` - Blood group
- `status` - Patient status (default active)
- `limit` - Results per page (default 50, max 1000)

### Bridges

- `GET /bridges` - List bridge relationships

Query parameters:
- `bridge_id` - Filter by bridge ID
- `patient_id` - Filter by patient
- `donor_id` - Filter by donor
- `limit` - Results per page (default 50, max 1000)

### Escalation Pool

- `GET /escalation-pool/{patient_id}` - Get all donors in escalation pool for a patient

Returns donors grouped by stage:
- **Stage 1**: Bridge Donors with matching blood group
- **Stage 2**: Emergency Donors (Regular, Active)
- **Stage 3**: All remaining active donors

### Ingestion

- `POST /ingest` - Trigger data ingestion

Response includes summary:
```json
{
  "success": true,
  "message": "Ingestion completed successfully",
  "summary": {
    "patients_inserted": 84,
    "donors_inserted": {
      "Bridge Donor": 2061,
      "Guest": 2420,
      "Emergency Donor": 2385,
      "Volunteer": 83
    },
    "bridges_created": 786,
    "bridges_skipped": 2,
    "escalation_pool": {
      "stage_1": 5234,
      "stage_2": 4521,
      "stage_3": 5479
    },
    "neo4j": {
      "nodes_created": 5925,
      "edges_created": 786
    }
  }
}
```

## Data Model

### Donors Table
- user_id (PK)
- blood_group, gender, latitude, longitude
- donor_category (Bridge Donor, Emergency Donor, Guest, Volunteer)
- normalized_reliability_score (0-1, from calls_to_donations_ratio)
- donations_till_date, eligibility_status
- last_donation_date, next_eligible_date
- frequency_in_days (0 for non-bridge donors, actual value for bridge donors)

### Patients Table
- patient_id (PK)
- blood_group, gender, latitude, longitude
- frequency_in_days (default 21)
- last_transfusion_date, expected_next_transfusion_date
- quantity_required, status

### Bridges Table
- bridge_id, donor_id (FK), patient_id
- chain_position (rank within bridge)
- donations_till_date, last_bridge_donation_date
- bridge_blood_group

### Escalation Pool Table
- patient_id, donor_id (unique constraint)
- pool_stage (1, 2, or 3)
- blood_group

### Additional Tables
- escalation_log, reservation_log, notifications_log
- conversation_history, learning_log

## Data Processing Rules

### Reliability Scoring

Donors have `normalized_reliability_score` (0-1) calculated from `calls_to_donations_ratio`:

```
IF total_calls > 0 AND donations_till_date is not null:
    score = min(1.0, donations_till_date / total_calls)
ELSE IF donations_till_date > 0:
    score = 0.8
ELSE:
    score = 0.0
```

### Expected Transfusion Date Recalculation

Fresh calculation for all patients:

```
IF last_transfusion_date is not null AND frequency_in_days > 0:
    expected = last_transfusion_date + timedelta(days=frequency_in_days)
ELSE:
    expected = today + timedelta(days=21)
```

### Bridge Chain Position

Within each bridge_id group, donors are ranked by donations_till_date DESC, with NULLs last:

```
chain_position = rank within bridge_id, ordered by donations_till_date DESC
```

## Database Access

### PostgreSQL

```bash
docker-compose exec postgres psql -U postgres -d idms
```

Common queries:

```sql
-- Count donors by category
SELECT donor_category, COUNT(*) FROM donors GROUP BY donor_category;

-- Donors with high reliability score
SELECT user_id, normalized_reliability_score FROM donors WHERE normalized_reliability_score > 0.8;

-- Patient transfusion schedule
SELECT patient_id, blood_group, expected_next_transfusion_date FROM patients WHERE status = 'active';

-- Bridge relationships for a patient
SELECT DISTINCT d.user_id, d.blood_group, b.chain_position 
FROM bridges b 
JOIN donors d ON b.donor_id = d.user_id 
WHERE b.patient_id = 'PATIENT_ID' 
ORDER BY b.chain_position;

-- Escalation pool for a patient
SELECT donor_id, pool_stage, blood_group FROM escalation_pool WHERE patient_id = 'PATIENT_ID';
```

### Neo4j

Web console: http://localhost:7474 (default credentials: neo4j/yourpassword)

Common queries:

```cypher
-- Find donors for a patient
MATCH (p:Patient {patient_id: "PATIENT_ID"})<-[:DONATED_FOR]-(d:Donor)
RETURN d.user_id, d.blood_group, d.donor_category, d.normalized_reliability_score

-- High-reliability donors by blood group
MATCH (d:Donor) WHERE d.normalized_reliability_score > 0.8 AND d.blood_group = "O+"
RETURN d.user_id, d.donor_category, d.normalized_reliability_score

-- Donation history via chain
MATCH (d1:Donor)-[:DONATED_FOR]->(p:Patient)<-[:DONATED_FOR]-(d2:Donor)
RETURN d1.user_id, d2.user_id, p.patient_id
LIMIT 100
```

## Development

### Running Locally (Without Docker)

1. Install Python 3.11
2. Create virtual environment:
   ```bash
   python -m venv venv
   source venv/bin/activate  # or: venv\Scripts\activate on Windows
   ```
3. Install dependencies:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```
4. Start PostgreSQL and Neo4j locally
5. Run the app:
   ```bash
   uvicorn main:app --reload
   ```

### Rebuilding After Code Changes

```bash
docker-compose down
docker-compose up --build
```

### Viewing Logs

```bash
docker-compose logs -f backend
docker-compose logs -f postgres
docker-compose logs -f neo4j
```

## Performance Notes

- **Indexes** on all foreign keys, blood_group, donor_category, pool_stage for fast queries
- **Upsert** on user_id for safe re-ingestion
- **Connection pooling** configured for high concurrency
- **Neo4j** graph for efficient relationship traversal

## Troubleshooting

### Services won't start

```bash
# Check logs
docker-compose logs

# Ensure ports are free
netstat -an | grep -E ":5432|:7687|:8000"

# Remove orphaned containers
docker-compose down --remove-orphans
docker volume prune
```

### Ingestion fails

```bash
# Verify Dataset.csv is readable
ls -la Dataset.csv

# Check environment variables
cat .env

# Re-run ingestion with verbose output
curl -X POST http://localhost:8000/ingest -v
```

### Database connection issues

```bash
# Test PostgreSQL connection
docker-compose exec backend psql -h postgres -U postgres -d idms -c "SELECT 1"

# Test Neo4j connection
docker-compose exec backend python -c "from neo4j import GraphDatabase; driver = GraphDatabase.driver('bolt://neo4j:7687'); print(driver.verify_connectivity())"
```

## Dataset Requirements

CSV must contain these columns:
- user_id, role, blood_group, gender, latitude, longitude
- Donor-specific: last_donation_date, donations_till_date, total_calls, calls_to_donations_ratio, frequency_in_days, donor_type, user_donation_active_status, eligibility_status, last_contacted_date, cycle_of_donations, status_of_bridge, role_status
- Patient-specific: quantity_required, frequency_in_days, last_transfusion_date, expected_next_transfusion_date
- Bridge-specific: bridge_id, bridge_blood_group, bridge_gender, last_bridge_donation_date, bridge_status

## Future Enhancements

- Real-time donor availability updates
- ML-based donor matching optimization
- Automated SMS/WhatsApp notifications
- Advanced analytics dashboard
- Integration with Blood Warriors' existing APIs
- Predictive patient transfusion scheduling

## License

Blood Warriors Foundation - 2025

## Support

For issues or questions, contact the development team.
