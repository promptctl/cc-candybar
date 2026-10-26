"""Export every project read, both runs, as the explorer app's data.json (argv[1] is its path).

Data comes from the same files build.py reads; the novelty patterns are taken from novel.py's PAT
literal so an item lands in the same group the README counts.
"""
import ast, json, glob, os, re, sys
from collections import defaultdict

DEST = sys.argv[1]
meas = json.load(open('/tmp/ccland/t2/measure.json'))
meta = json.load(open('/tmp/ccland/meta.json'))
fnames = json.load(open('/tmp/ccland/famnames.json'))
src = open('/tmp/ccland/novel.py').read()
PAT = next(ast.literal_eval(n.value) for n in ast.parse(src).body
           if isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') == 'PAT')
motives = dict(re.findall(r'^(M\d\d) (.+)$', open('/tmp/ccland/why-brief.md').read(), re.M))
BANDS = [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')]


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
        p = {'rank': rank, 'band': '45+' if is_top else next(b for lo, b in BANDS if q['own_commits'] >= lo),
             'repo': q['repo'], 'url': q['url'], 'commits': q['own_commits'],
             'last': (q.get('last') or '')[:10], 'lang': md.get('lang') or '', 'what': r.get('what', ''),
             'kind': kind, 'shape': shape, 'motive': motive.get(k, ''), 'fams': sorted(fams.get(k, [])), 'loc': loc,
             'fam': family_of.get(k), 'novel': nov, 'boring': boring,
             'copy': [[o.replace('__', '/', 1), round(100 * a)] for o, n, a, _ in m.get('shares', [])[:3]]}
        if not boring:  # boring rows carry no drill-down, so their long fields are left out of the page
            p.update({'created': (md.get('created') or '')[:10], 'size': r.get('size', ''),
                      'sources': r.get('data sources', ''), 'lineage': r.get('lineage', ''),
                      'why': r.get('why it exists', ''), 'beyond': r.get('beyond baseline', ''),
                      'summary': r.get('summary', ''), 'fork': q.get('parent') or ''})
        projects.append(p)

groups = [name for name, _ in PAT] + ['unsorted']
data = {'projects': projects, 'families': families, 'fnames': fnames, 'motives': motives, 'groups': groups}
json.dump(data, open(DEST, 'w'), separators=(',', ':'))
print(len(projects), 'projects;', sum(p['boring'] for p in projects), 'just print fields;',
      sum(bool(p['novel']) for p in projects), 'with a new idea')
