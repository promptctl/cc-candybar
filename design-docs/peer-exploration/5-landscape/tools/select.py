"""Rank projects by commit activity and pick the top N into selected.json.

Excludes: not a Claude statusline per the scanner (N), unreachable, and "a few commits
with none recent" (< FEW commits and no commit in the last 90 days). Forks rank by the
commits they added over their parent (ahead_by in forks.json), since their history
otherwise counts the parent's work.
"""
import json, re, sys
from collections import Counter

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1000
FEW = 5
projects = json.load(open('/tmp/ccland/projects.json'))
act = json.load(open('/tmp/ccland/activity.json'))
try:
    forks = json.load(open('/tmp/ccland/forks.json'))
except FileNotFoundError:
    forks = {}

seen, pool, why = set(), [], Counter()
for p in projects:
    a = act.get(p['url'])
    if p['statusline'] == 'N':
        why['scanner: not a statusline'] += 1; continue
    if not a:
        why['no commit history (npm/web/registry page)'] += 1; continue
    if a['status'] != 'ok':
        why['unreachable'] += 1; continue
    if a['repo'] in seen or a['repo'] == 'promptctl/cc-candybar':
        why['duplicate url'] += 1; continue
    seen.add(a['repo'])
    own = a['commits']
    if a.get('fork'):
        f = forks.get(a['repo'])
        own = f['ahead'] if f and f.get('ahead') is not None else 0
    recent = a['recent'] if not a.get('fork') else min(a['recent'], own)
    if own < FEW and recent == 0:
        why['few commits, none recent'] += 1; continue
    q = dict(p); q.update(a); q['own_commits'] = own; q['recent_own'] = recent
    q['slug'] = re.sub(r'[^A-Za-z0-9._-]+', '__', a['repo'])
    pool.append(q)

pool.sort(key=lambda q: (-q['own_commits'], -q['recent_own']))
sel = pool[:N]
json.dump(sel, open('/tmp/ccland/selected.json', 'w'))
json.dump({'excluded': why, 'eligible': len(pool), 'cutoff_commits': sel[-1]['own_commits'] if sel else None,
           'forks_in_selection': sum(1 for q in sel if q.get('fork'))}, open('/tmp/ccland/select-stats.json', 'w'), indent=1)
print(json.dumps(why), 'eligible', len(pool), 'cutoff', sel[-1]['own_commits'] if sel else None)
print('kinds', Counter(q['kind'] for q in sel), 'forks', sum(1 for q in sel if q.get('fork')))
