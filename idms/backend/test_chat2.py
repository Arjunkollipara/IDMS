import urllib.request, json

donor_id = '\xe045b931633700bc0c02a1e8419a6ae338765c4bdbafea0e497ab10bc9094eed'

payload = json.dumps({
    'donor_id': donor_id,
    'patient_id': 'demo-patient-001',
    'message': 'Thank you for donating!',
    'sender': 'patient'
}).encode()

req = urllib.request.Request('http://localhost:8000/chat', data=payload, headers={'Content-Type': 'application/json'}, method='POST')
try:
    resp = urllib.request.urlopen(req, timeout=90)
    result = json.loads(resp.read())
    print('SUCCESS')
    print('Response:', result.get('response'))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8', errors='replace')
    print('HTTP Error', e.code)
    print('Body:', body)
except Exception as e:
    print('Error:', type(e).__name__, str(e))
