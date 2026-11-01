"""Export every project read, both runs, as the explorer app's data.json (argv[1] is its path),
and the captured bars as script bundles in the directory argv[2]: b000.js, b001.js, ... Each holds
ten projects' bars, gzipped and base64 so the bundle is a single script. The page loads the bundle
of a project when that project is selected.

Data comes from the same files build.py reads; the novelty patterns are taken from novel.py's PAT
literal so an item lands in the same group the README counts.
"""
import ast, base64, gzip, json, glob, os, re, sys
from collections import defaultdict

DEST, PUBLIC = sys.argv[1], sys.argv[2]
BARS_DIR, DETAIL_DIR = os.path.join(PUBLIC, 'bars'), os.path.join(PUBLIC, 'detail')
meas = json.load(open('/tmp/ccland/t2/measure.json'))
meta = json.load(open('/tmp/ccland/meta.json'))
fnames = json.load(open('/tmp/ccland/famnames.json'))
src = open('/tmp/ccland/novel.py').read()
PAT = next(ast.literal_eval(n.value) for n in ast.parse(src).body
           if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'PAT')
motives = dict(re.findall(r'^(M\d\d) (.+)$', open('/tmp/ccland/why-brief.md').read(), re.M))
BANDS = [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')]
# What tools/capture produced: the risk tier of every project, and the bytes each safe one printed.
tiers = json.load(open('/tmp/ccland/tiers.json'))
captures = json.load(open('/tmp/ccland/captures.json'))


def group_of(text):
    return next((name for name, rx in PAT if re.search(rx, text, re.I)), 'unsorted')


def load(run):
    rows = json.load(open(run + '/rows.json'))
    keys = json.load(open(run + '/why-keys.json'))
    motive = {}
    for f in sorted(glob.glob(run + '/cls/why-out-*.tsv')):
        for l in open(f):
            p = l.rstrip('\n').split('\t')
            if len(p) >= 2 and p[0].strip().isdigit():
                motive[keys[int(p[0])]] = p[1].strip()
    fams = defaultdict(list)
    for code, projs in json.load(open(run + '/fam.json')).items():
        for p in projs:
            fams[p].append(code)
    other = json.load(open(run + '/other.json'))
    novel = defaultdict(list)
    for f in sorted(glob.glob(run + '/cls/nov-out-*.tsv')):
        for l in open(f):
            p = l.rstrip('\n').split('\t', 2)
            if len(p) >= 2 and p[1] == 'unusual':
                proj, _, it = other[int(p[0])]
                why = p[2] if len(p) > 2 else ''
                novel[proj.lower()].append([it, why, group_of(it + ' ' + why)])
    return rows, motive, fams, novel


family_of = {}
families = []
for i, f in enumerate(json.load(open('/tmp/ccland/t2/families-all.json'))):
    families.append({'size': f['size'], 'members': [m['repo'] for m in f['members']]})
    for m in f['members']:
        family_of[m['repo'].lower()] = i

top = json.load(open('/tmp/ccland/selected.json'))
everyone = json.load(open('/tmp/ccland/t2/all.json'))
picked = {q['slug'] for q in json.load(open('/tmp/ccland/t2/selected.json'))}
runs = [('/tmp/ccland', True, list(enumerate(top, 1))),
        ('/tmp/ccland/t2', False, [(len(top) + i, q) for i, q in enumerate(everyone, 1) if q['slug'] in picked])]

projects = []
bars = {}  # repo -> frames by width, written as bundles
details = {}  # repo -> the long fields the project view shows, written as bundles
for run, is_top, ranked in runs:
    rows, motive, fams, novel = load(run)
    for rank, q in ranked:
        k = q['repo'].lower()
        r, m, md = rows.get(k, {}), meas.get(q['slug'], {}), meta.get(q['repo'], {})
        nov = novel.get(k, [])
        shape = (r.get('shape') or '').split()[0] if r.get('shape') else ''
        loc = m.get('sl_loc', 0)
        kind = re.split(r'[(:;,]', r.get('what', ''))[0].strip()
        # a project that only prints Claude Code's input fields gets no drill-down; one that is not a statusline still does
        boring = not nov and kind != 'not a statusline' and (shape == 'field' or loc < 50)
        # the link is written only when it is not the repository's GitHub page; the page derives that one
        url = q['url'] if q['url'] != 'https://github.com/' + q['repo'] else None
        p = {'rank': rank, 'band': '45+' if is_top else next(b for lo, b in BANDS if q['own_commits'] >= lo),
             'repo': q['repo'], 'url': url, 'commits': q['own_commits'],
             'last': (q.get('last') or '')[:10], 'lang': md.get('lang') or '', 'what': r.get('what', ''),
             'shape': shape, 'motive': motive.get(k, ''), 'fams': sorted(fams.get(k, [])), 'loc': loc,
             'fam': family_of.get(k), 'novel': nov, 'boring': boring,
             'copy': [[o.replace('__', '/', 1), round(100 * a)] for o, n, a, _ in m.get('shares', [])[:3]]}
        p['tier'] = tiers[q['slug']]['tier']
        cap = captures.get(q['slug'])
        p['live'] = bool(cap and cap['ok'])
        if p['live']:
            # the frames at each terminal width, keeping only widths whose frames differ from the narrower one
            frames, last = {}, None
            for w in sorted(cap['frames'], key=int):
                if cap['frames'][w] and cap['frames'][w] != last:
                    frames[w] = last = cap['frames'][w]
            bars[q['repo']] = frames
        if not boring:  # boring rows carry no drill-down, so they have no detail bundle
            details[q['repo']] = {'created': (md.get('created') or '')[:10], 'size': r.get('size', ''),
                                  'sources': r.get('data sources', ''), 'lineage': r.get('lineage', ''),
                                  'why': r.get('why it exists', ''), 'beyond': r.get('beyond baseline', ''),
                                  'summary': r.get('summary', ''), 'fork': q.get('parent') or ''}
        projects.append({k: v for k, v in p.items() if v is not None})  # a null link is absent, not written

groups = [name for name, _ in PAT] + ['unsorted']
# [LAW:one-source-of-truth] A project's bundle is decided here and recorded on the project; the page only follows the number.
# A bundle is a script, so the page loads it from disk with no server. It is loaded when its project is selected.
def bundle(kind, folder, by_repo, per):
    """Write by_repo's values into script bundles of `per` projects each; returns repo -> bundle number."""
    where = {repo: i // per for i, repo in enumerate(by_repo)}
    groups = defaultdict(dict)
    for repo, value in by_repo.items():
        groups[where[repo]][repo] = value
    for old in glob.glob(os.path.join(folder, 'b*.js')):
        os.remove(old)
    os.makedirs(folder, exist_ok=True)
    for n, group in groups.items():
        packed = base64.b64encode(gzip.compress(json.dumps(group, separators=(',', ':')).encode(), 9)).decode()
        open(os.path.join(folder, 'b%03d.js' % n), 'w').write('window.ccBundle("%s",%d,"%s")' % (kind, n, packed))
    return where


bar_at = bundle('bars', BARS_DIR, bars, 10)
detail_at = bundle('detail', DETAIL_DIR, details, 50)
for p in projects:
    p['bar'] = bar_at.get(p['repo'])
    p['detail'] = detail_at.get(p['repo'])
data = {'projects': projects, 'families': families, 'fnames': fnames, 'motives': motives, 'groups': groups}
json.dump(data, open(DEST, 'w'), separators=(',', ':'))
print(len(projects), 'projects;', sum(p['boring'] for p in projects), 'just print fields;',
      sum(bool(p['novel']) for p in projects), 'with a new idea')
