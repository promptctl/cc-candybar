"""For every fork in activity.json, count commits it added over its parent (ahead_by)."""
import json, subprocess, sys, urllib.request, urllib.error
import concurrent.futures as cf

TOKEN = subprocess.check_output(['gh', 'auth', 'token'], text=True).strip()
H = {'Authorization': 'token ' + TOKEN, 'User-Agent': 'ccland/1.0', 'Accept': 'application/vnd.github+json'}
act = json.load(open('/tmp/ccland/activity.json'))


def get(u):
    try:
        return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=60).read())
    except urllib.error.HTTPError as e:
        return {'_err': e.code}


def one(repo):
    r = get('https://api.github.com/repos/' + repo)
    par = r.get('parent')
    if not par:
        return repo, {'ahead': None, 'err': r.get('_err')}
    po = par['owner']['login']
    c = get('https://api.github.com/repos/%s/compare/%s...%s:%s' % (par['full_name'], par['default_branch'],
                                                                      r['owner']['login'], r['default_branch']))
    return repo, {'parent': par['full_name'], 'ahead': c.get('ahead_by'), 'behind': c.get('behind_by'), 'err': c.get('_err')}


repos = sorted({v['repo'] for v in act.values() if v.get('status') == 'ok' and v.get('fork')})
out = {}
with cf.ThreadPoolExecutor(6) as ex:
    for repo, rec in ex.map(one, repos):
        out[repo] = rec
json.dump(out, open('/tmp/ccland/forks.json', 'w'))
print(len(out), 'forks', sum(1 for v in out.values() if v['ahead'] is None), 'unresolved', file=sys.stderr)
