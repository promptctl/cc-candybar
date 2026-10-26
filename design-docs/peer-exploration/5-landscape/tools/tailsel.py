"""Every eligible project outside the top 1,000, in the selected.json shape, into t2/all.json."""
import json, os, re

proj = json.load(open('/tmp/ccland/projects.json'))
act = json.load(open('/tmp/ccland/activity.json'))
forks = json.load(open('/tmp/ccland/forks.json'))
chosen = {q['repo'] for q in json.load(open('/tmp/ccland/selected.json'))}
seen, out = set(), []
for p in proj:
    a = act.get(p['url'])
    if p['statusline'] == 'N' or not a or a['status'] != 'ok' or a['repo'] in seen or a['repo'] == 'promptctl/cc-candybar':
        continue
    seen.add(a['repo'])
    if a['repo'] in chosen:
        continue
    own = a['commits']
    if a.get('fork'):
        f = forks.get(a['repo'])
        own = f['ahead'] if f and f.get('ahead') is not None else 0
    q = dict(p); q.update(a)
    q['own_commits'] = own
    q['recent_own'] = a['recent'] if not a.get('fork') else min(a['recent'], own)
    q['slug'] = re.sub(r'[^A-Za-z0-9._-]+', '__', a['repo'])
    out.append(q)
out.sort(key=lambda q: (-q['own_commits'], -q['recent_own']))
os.makedirs('/tmp/ccland/t2', exist_ok=True)
json.dump(out, open('/tmp/ccland/t2/all.json', 'w'))
print(len(out), 'projects;', sum(1 for q in out if q['kind'] == 'gist'), 'gists;',
      sum(1 for q in out if q['kind'] not in ('gh', 'gist')), 'other forges')
