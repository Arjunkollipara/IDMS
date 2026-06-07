import requests
import json

# Test health
r = requests.get('http://localhost:8000/health')
print('=== HEALTH CHECK ===')
data = r.json()
print(f"Status: {data.get('status')}")
print(f"Database: {data.get('database_status')}")
print(f"Neo4j: {data.get('neo4j_status')}")
print(f"Table Counts: {data.get('table_counts')}")
print()

# Test get patients
r = requests.get('http://localhost:8000/patients?limit=3')
print('=== SAMPLE PATIENTS ===')
data = r.json()
if data.get('success'):
    for p in data.get('patients', [])[:3]:
        print(f"- {p.get('patient_id')} ({p.get('blood_group')}) - {p.get('status')}")
print()

# Test get donors
r = requests.get('http://localhost:8000/donors?limit=5&category=Bridge%20Donor')
print('=== SAMPLE BRIDGE DONORS ===')
data = r.json()
if data.get('success'):
    for d in data.get('donors', [])[:5]:
        print(f"- {d.get('user_id')} ({d.get('blood_group')}) - Score: {d.get('normalized_reliability_score')}")
print()

# Test escalation pool
r = requests.get('http://localhost:8000/donors?limit=1')
if r.json().get('patients'):
    patient_id = r.json()['patients'][0]['patient_id']
    r = requests.get(f'http://localhost:8000/escalation-pool/{patient_id}')
    print('=== ESCALATION POOL SAMPLE ===')
    data = r.json()
    if data.get('success'):
        print(f"Patient: {patient_id}")
        for stage, donors in data.get('pool', {}).items():
            print(f"  Stage {stage}: {len(donors)} donors")
