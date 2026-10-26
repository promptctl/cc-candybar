"""Assemble the deliverables into the worktree's design-docs/peer-exploration/5-landscape/."""
import json, glob, os, re, sys, shutil
from collections import Counter

DEST = sys.argv[1]
os.makedirs(DEST, exist_ok=True)
sel = json.load(open('/tmp/ccland/selected.json'))
rows = json.load(open('/tmp/ccland/rows.json'))
meas = json.load(open('/tmp/ccland/measure.json'))
meta = json.load(open('/tmp/ccland/meta.json'))
fam = json.load(open('/tmp/ccland/fam.json'))
names = json.load(open('/tmp/ccland/famnames.json'))
keys = json.load(open('/tmp/ccland/why-keys.json'))

motive = {}
for f in sorted(glob.glob('/tmp/ccland/cls/why-out-*.tsv')):
    for l in open(f):
        p = l.rstrip('\n').split('\t')
        if len(p) >= 2 and p[0].strip().isdigit():
            motive[keys[int(p[0])]] = p[1].strip()
proj_fams = {}
for code, projs in fam.items():
    for p in projs:
        proj_fams.setdefault(p, []).append(code)

# raw section text by repo
sections = {}
for f in sorted(glob.glob('/tmp/ccland/out/batch-*.md')):
    for sec in re.split(r'^## ', open(f).read(), flags=re.M)[1:]:
        head, _, body = sec.partition('\n')
        key = head.strip().strip('`').lower()
        if key not in rows:
            m = [k for k in rows if k.split('/')[-1] == key.split('/')[-1]]
            key = m[0] if len(m) == 1 else key
        sections[key] = body.strip()


def first(s, n):
    return (s or '').split('\n')[0][:n]


cat = ['# The 1,000 most-committed Claude Code statuslines, one section each',
       '',
       'Ranked by commits (a fork counts only the commits it added over its parent). Each section was written by a haiku agent from the project\'s downloaded source on 2026-10-25; anchors point into that source. How the list was chosen and what the fields mean: [README.md](README.md).',
       '']
tsv = ['rank\trepo\turl\tstars\tcommits\tcommits_90d\tlast_commit\tcreated\tlanguage\tfork_of\twhat\tshape\tmotive\tfeature_families\tstatusline_loc\tclones_of']
for i, q in enumerate(sel, 1):
    k = q['repo'].lower()
    r = rows.get(k, {})
    m = meas.get(q['slug'], {})
    md = meta.get(q['repo'], {})
    cat.append('## %d. %s' % (i, q['repo']))
    cat.append('%s commits (%s in the last 90 days), %s stars, last commit %s' % (
        q['own_commits'], q['recent_own'], q.get('stars'), (q.get('last') or '?')[:10]))
    cat.append(sections.get(k, '- unreadable: no section'))
    cat.append('')
    clones = ';'.join('%s %d%%' % (o.replace('__', '/', 1), 100 * a) for o, n, a, b in m.get('shares', [])[:3])
    tsv.append('\t'.join(str(x) for x in [
        i, q['repo'], q['url'], q.get('stars'), q['own_commits'], q['recent_own'], (q.get('last') or '')[:10],
        (md.get('created') or '')[:10], md.get('lang') or '', q.get('parent') or '',
        first(r.get('what'), 60), first(r.get('shape'), 20), motive.get(k, ''),
        ','.join(sorted(proj_fams.get(k, []))), m.get('sl_loc', ''), clones]))
open(os.path.join(DEST, 'projects.md'), 'w').write('\n'.join(cat) + '\n')
open(os.path.join(DEST, 'projects.tsv'), 'w').write('\n'.join(tsv) + '\n')
open(os.path.join(DEST, 'families.md'), 'w').write(
    '# Feature families\n\nCodes used in `projects.tsv`; counts are in [README.md](README.md).\n\n' +
    '\n'.join('- %s %s' % (c, n) for c, n in sorted(names.items())) + '\n')
tools = os.path.join(DEST, 'tools')
os.makedirs(tools, exist_ok=True)
for f in ['parse.py', 'fetch.py', 'forks.py', 'select.py', 'meta.py', 'download.py', 'fingerprint.py',
          'families.py', 'batches.py', 'collect.py', 'famcount.py', 'lineage.py', 'build.py', 'brief.md',
          'classify-brief.md', 'novel-brief.md']:
    shutil.copy(os.path.join('/tmp/ccland', f), tools)
print('wrote', len(sel), 'sections; motives', len(motive), Counter(motive.values()).most_common(20))
