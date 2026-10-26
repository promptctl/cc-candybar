"""createdAt, primary language and topics for selected GitHub repos -> meta.json."""
import json, subprocess, urllib.request

TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
sel = json.load(open('/tmp/ccland/selected.json'))
gh = [q for q in sel if q['kind'] == 'gh']
out = {}
Q = 'r%d: repository(owner:%s, name:%s) { createdAt primaryLanguage { name } description }'
for i in range(0, len(gh), 80):
    b = gh[i:i + 80]
    parts = [Q % (j, json.dumps(q['repo'].split('/')[0]), json.dumps(q['repo'].split('/')[1])) for j, q in enumerate(b)]
    body = json.dumps({'query': '{' + '\n'.join(parts) + '}'}).encode()
    r = urllib.request.urlopen(urllib.request.Request('https://api.github.com/graphql', body,
                               {'Authorization': 'bearer ' + TOKEN, 'Content-Type': 'application/json'}), timeout=120)
    d = json.loads(r.read()).get('data') or {}
    for j, q in enumerate(b):
        x = d.get('r%d' % j) or {}
        out[q['repo']] = {'created': x.get('createdAt'), 'lang': (x.get('primaryLanguage') or {}).get('name'),
                          'ghdesc': x.get('description')}
json.dump(out, open('/tmp/ccland/meta.json', 'w'))
print(len(out))
