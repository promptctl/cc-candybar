"""createdAt, primary language and topics for selected GitHub repos -> meta.json.

Covers the top 1,000 and the read tail; repos already in meta.json are not refetched."""
import json, os, subprocess, urllib.request

TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
OUT = '/tmp/ccland/meta.json'
out = json.load(open(OUT)) if os.path.exists(OUT) else {}
sel = [q for f in ['/tmp/ccland/selected.json', '/tmp/ccland/t2/selected.json'] for q in json.load(open(f))]
gh = [q for q in sel if q['kind'] == 'gh' and q['repo'] not in out]
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
json.dump(out, open(OUT, 'w'))
print(len(gh), 'fetched;', len(out), 'in meta.json;', sum(1 for q in gh if not out[q['repo']]['created']), 'not found')
