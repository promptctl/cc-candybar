"""Fetch commit count, recency and fork status for every project in projects.json.

Writes /tmp/ccland/activity.json keyed by project url. Reruns skip urls already held.
"""
import json, subprocess, sys, time, urllib.request, urllib.parse, urllib.error
import concurrent.futures as cf

OUT = '/tmp/ccland/activity.json'
SINCE = '2026-07-27T00:00:00Z'  # 90 days before 2026-10-25
TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
projects = json.load(open('/tmp/ccland/projects.json'))
try:
    act = json.load(open(OUT))
except FileNotFoundError:
    act = {}


def save():
    json.dump(act, open(OUT, 'w'))


def req(url, data=None, headers=None, tries=4):
    h = {'User-Agent': 'ccland/1.0'}
    h.update(headers or {})
    for i in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=60)
            return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            if e.code in (404, 410, 451):
                return e.code, dict(e.headers), b''
            if e.code in (403, 429, 502, 503, 504) and i < tries - 1:
                time.sleep(20 * (i + 1)); continue
            return e.code, dict(e.headers), e.read()
        except Exception as e:
            if i < tries - 1:
                time.sleep(5); continue
            return 0, {}, str(e).encode()


Q = '''r%d: repository(owner:%s, name:%s) { nameWithOwner isFork isArchived pushedAt stargazerCount
 parent { nameWithOwner } defaultBranchRef { target { ... on Commit { committedDate
 history { totalCount } recent: history(since:"%s") { totalCount } } } } }'''


def gh_batch(batch):
    parts = []
    for i, p in enumerate(batch):
        o, n = p['id'].split('/', 1)
        parts.append(Q % (i, json.dumps(o), json.dumps(n), SINCE))
    body = json.dumps({'query': '{' + '\n'.join(parts) + '}'}).encode()
    st, hd, raw = req('https://api.github.com/graphql', body,
                      {'Authorization': 'bearer ' + TOKEN, 'Content-Type': 'application/json'})
    if st != 200:
        print('graphql', st, raw[:300], file=sys.stderr); return
    d = json.loads(raw).get('data') or {}
    for i, p in enumerate(batch):
        r = d.get('r%d' % i)
        if r is None:
            act[p['url']] = {'status': 'missing'}; continue
        t = (r.get('defaultBranchRef') or {}).get('target') or {}
        act[p['url']] = {
            'status': 'ok', 'repo': r['nameWithOwner'], 'fork': r['isFork'],
            'parent': (r.get('parent') or {}).get('nameWithOwner'), 'archived': r['isArchived'],
            'stars': r['stargazerCount'], 'pushed': r['pushedAt'],
            'last': t.get('committedDate'), 'commits': (t.get('history') or {}).get('totalCount', 0),
            'recent': (t.get('recent') or {}).get('totalCount', 0)}


def gist(p):
    h = {'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github+json'}
    st, hd, raw = req('https://api.github.com/gists/%s/commits?per_page=100' % p['id'], headers=h)
    if st != 200:
        return p['url'], {'status': 'missing' if st == 404 else 'err%d' % st}
    cs = json.loads(raw)
    dates = sorted(c['committed_at'] for c in cs)
    return p['url'], {'status': 'ok', 'repo': 'gist:' + p['id'], 'fork': False, 'parent': None,
                      'commits': len(cs), 'last': dates[-1] if dates else None,
                      'recent': sum(1 for x in dates if x >= SINCE)}


def forge(p):
    if p['kind'] == 'gitlab.com':
        u = 'https://gitlab.com/api/v4/projects/%s/repository/commits?per_page=100&all=true' % urllib.parse.quote(p['id'], safe='')
    else:
        u = 'https://codeberg.org/api/v1/repos/%s/commits?limit=50' % p['id']
    st, hd, raw = req(u)
    if st != 200:
        return p['url'], {'status': 'missing'}
    cs = json.loads(raw)
    total = int(hd.get('X-Total') or hd.get('X-Total-Count') or hd.get('x-total-count') or len(cs))
    ds = [(c.get('committed_date') or c.get('created') or (c.get('commit') or {}).get('committer', {}).get('date') or '') for c in cs]
    ds = sorted(d for d in ds if d)
    return p['url'], {'status': 'ok', 'repo': p['kind'] + ':' + p['id'], 'fork': False, 'parent': None,
                      'commits': total, 'last': ds[-1] if ds else None, 'recent': sum(1 for x in ds if x >= SINCE)}


want = [p for p in projects if p['statusline'] != 'N' and p['url'] not in act]
gh = [p for p in want if p['kind'] == 'gh']
print('todo gh', len(gh), file=sys.stderr)
for i in range(0, len(gh), 40):
    gh_batch(gh[i:i + 40])
    if i % 400 == 0:
        save(); print(i, file=sys.stderr)
save()
others = [p for p in want if p['kind'] in ('gist', 'gitlab.com', 'codeberg.org')]
print('todo others', len(others), file=sys.stderr)
with cf.ThreadPoolExecutor(6) as ex:
    for n, (u, rec) in enumerate(ex.map(lambda p: gist(p) if p['kind'] == 'gist' else forge(p), others)):
        act[u] = rec
        if n % 200 == 0:
            save()
save()
from collections import Counter
print(Counter(v['status'] for v in act.values()), file=sys.stderr)
