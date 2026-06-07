import urllib.request, json
from urllib.parse import quote

donor_id = '\xe045b931633700bc0c02a1e8419a6ae338765c4bdbafea0e497ab10bc9094eed'
encoded = quote(donor_id, safe='')
url = 'http://localhost:8000/conversations/' + encoded + '?patient_id=demo-patient-001&caller=patient'
r = urllib.request.urlopen(url, timeout=15)
data = json.loads(r.read())
hist = data.get('history', [])
print('History count:', len(hist))
for item in hist[-8:]:
    role = item['role']
    msg = item['message'][:120]
    print('  role=' + role + ' | ' + msg)
