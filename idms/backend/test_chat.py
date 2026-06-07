import urllib.request, json

donor_id = '\xe045b931633700bc0c02a1e8419a6ae338765c4bdbafea0e497ab10bc9094eed'

# Test 1: patient sends message - AI should respond as DONOR
payload = json.dumps({
    'donor_id': donor_id,
    'patient_id': 'demo-patient-001',
    'message': 'Thank you so much for donating blood for me!',
    'sender': 'patient'
}).encode()
req = urllib.request.Request('http://localhost:8000/chat', data=payload, headers={'Content-Type': 'application/json'}, method='POST')
resp = urllib.request.urlopen(req, timeout=60)
result = json.loads(resp.read())
print('TEST 1: patient->chat')
print('  Response:', result.get('response'))
print()

# Test 2: coordinator sends message - AI should respond as DONOR  
payload2 = json.dumps({
    'donor_id': donor_id,
    'patient_id': 'demo-patient-001',
    'message': 'Hi, can you donate next week?',
    'sender': 'coordinator'
}).encode()
req2 = urllib.request.Request('http://localhost:8000/chat', data=payload2, headers={'Content-Type': 'application/json'}, method='POST')
resp2 = urllib.request.urlopen(req2, timeout=60)
result2 = json.loads(resp2.read())
print('TEST 2: coordinator->chat')
print('  Response:', result2.get('response'))
print()

# Test 3: donor sends message - AI should respond as COORDINATOR (Priya)
payload3 = json.dumps({
    'donor_id': donor_id,
    'patient_id': 'demo-patient-001',
    'message': 'Yes I am available to donate',
    'sender': 'donor'
}).encode()
req3 = urllib.request.Request('http://localhost:8000/chat', data=payload3, headers={'Content-Type': 'application/json'}, method='POST')
resp3 = urllib.request.urlopen(req3, timeout=60)
result3 = json.loads(resp3.read())
print('TEST 3: donor->chat')
print('  Response:', result3.get('response'))
