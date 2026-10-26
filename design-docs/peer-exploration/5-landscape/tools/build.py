"""Assemble the deliverables into the worktree's design-docs/peer-exploration/5-landscape/.

The top 1,000 (/tmp/ccland) go to projects.md, the agent-read tail (/tmp/ccland/t2) to
projects-tail.md, and both to projects.tsv. Ranks run over every eligible project by commits,
so a tail project's rank says how many projects outrank it, not how many were read.
"""
import json, glob, os, re, sys, shutil
from collections import Counter

DEST = sys.argv[1]
os.makedirs(DEST, exist_ok=True)
meas = json.load(open('/tmp/ccland/t2/measure.json'))  # [LAW:one-source-of-truth] one overlap measure over all 7,046, for every row
meta = json.load(open('/tmp/ccland/meta.json'))
names = json.load(open('/tmp/ccland/famnames.json'))
BANDS = [(20, '20-44'), (10, '10-19'), (5, '5-9'), (2, '2-4'), (0, '0-1')]


def band(q, top):
    return '45+' if top else next(b for lo, b in BANDS if q['own_commits'] >= lo)


def load(run):
    rows = json.load(open(run + '/rows.json'))
    keys = json.load(open(run + '/why-keys.json'))
    motive = {}
    for f in sorted(glob.glob(run + '/cls/why-out-*.tsv')):
        for l in open(f):
            p = l.rstrip('\n').split('\t')
            if len(p) >= 2 and p[0].strip().isdigit():
                motive[keys[int(p[0])]] = p[1].strip()
    fams = {}
    for code, projs in json.load(open(run + '/fam.json')).items():
        for p in projs:
            fams.setdefault(p, []).append(code)
    sections = {}
    for f in sorted(glob.glob(run + '/out/batch-*.md')):
        for sec in re.split(r'^## ', open(f).read(), flags=re.M)[1:]:
            head, _, body = sec.partition('\n')
            key = head.strip().strip('`').lower()
            if key not in rows:
                m = [k for k in rows if k.split('/')[-1] == key.split('/')[-1]]
                key = m[0] if len(m) == 1 else key
            sections[key] = body.strip()
    return rows, motive, fams, sections


def first(s, n):
    return (s or '').split('\n')[0][:n]


top = json.load(open('/tmp/ccland/selected.json'))
everyone = json.load(open('/tmp/ccland/t2/all.json'))
picked = {q['slug'] for q in json.load(open('/tmp/ccland/t2/selected.json'))}
runs = [('/tmp/ccland', True, list(enumerate(top, 1))),
        ('/tmp/ccland/t2', False, [(len(top) + i, q) for i, q in enumerate(everyone, 1) if q['slug'] in picked])]

tsv = ['rank\tband\trepo\turl\tstars\tcommits\tcommits_90d\tlast_commit\tcreated\tlanguage\tfork_of\twhat\tshape\tmotive\tfeature_families\tstatusline_loc\tclones_of']
docs = {True: ['# The 1,000 most-committed Claude Code statuslines, one section each', '',
               'Ranked by commits (a fork counts only the commits it added over its parent). Each section was written by a haiku agent from the project\'s downloaded source on 2026-10-25; anchors point into that source. How the list was chosen and what the fields mean: [README.md](README.md). The less-committed projects read afterwards are in [projects-tail.md](projects-tail.md).', ''],
        False: ['# 3,002 less-committed Claude Code statuslines, one section each', '',
                'Every project with 10 to 44 commits (the 20-44 band opens with six tied at 45 that fell just outside the top 1,000), the 2-9 commit projects with at least 200 lines of statusline code that are not mostly a copy of one already read, and the 0-1 commit projects with at least 400 such lines. Ranks continue from [projects.md](projects.md) over every eligible project, so gaps are the projects not read. Sections were written by haiku agents from the downloaded source on 2026-10-26. Selection and fields: [README.md](README.md).', '']}
motives = Counter()
for run, is_top, ranked in runs:
    rows, motive, fams, sections = load(run)
    cat, cur = docs[is_top], None
    for rank, q in ranked:
        k = q['repo'].lower()
        r, m, md, b = rows.get(k, {}), meas.get(q['slug'], {}), meta.get(q['repo'], {}), band(q, is_top)
        if not is_top and b != cur:
            cur = b
            cat += ['## %s commits' % b, '']
        cat.append('%s %d. %s' % ('##' if is_top else '###', rank, q['repo']))
        cat.append('%s commits (%s in the last 90 days), %s stars, last commit %s' % (
            q['own_commits'], q['recent_own'], q.get('stars'), (q.get('last') or '?')[:10]))
        cat.append(sections.get(k, '- unreadable: no section'))
        cat.append('')
        motives[motive.get(k, '')] += 1
        clones = ';'.join('%s %d%%' % (o.replace('__', '/', 1), 100 * a) for o, n, a, _ in m.get('shares', [])[:3])
        tsv.append('\t'.join(str(x) for x in [
            rank, b, q['repo'], q['url'], q.get('stars'), q['own_commits'], q['recent_own'], (q.get('last') or '')[:10],
            (md.get('created') or '')[:10], md.get('lang') or '', q.get('parent') or '',
            first(r.get('what'), 60), first(r.get('shape'), 20), motive.get(k, ''),
            ','.join(sorted(fams.get(k, []))), m.get('sl_loc', ''), clones]))
    open(os.path.join(DEST, 'projects.md' if is_top else 'projects-tail.md'), 'w').write('\n'.join(cat) + '\n')
open(os.path.join(DEST, 'projects.tsv'), 'w').write('\n'.join(tsv) + '\n')
open(os.path.join(DEST, 'families.md'), 'w').write(
    '# Feature families\n\nCodes used in `projects.tsv`; counts are in [README.md](README.md).\n\n' +
    '\n'.join('- %s %s' % (c, n) for c, n in sorted(names.items())) + '\n')
tools = os.path.join(DEST, 'tools')
os.makedirs(tools, exist_ok=True)
for f in ['parse.py', 'fetch.py', 'forks.py', 'select.py', 'meta.py', 'download.py', 'fingerprint.py',
          'families.py', 'batches.py', 'collect.py', 'famcount.py', 'lineage.py', 'build.py', 'brief.md',
          'classify-brief.md', 'novel-brief.md', 'tailsel.py', 'pick.py', 'clones.py', 'chain.py', 'stages.py',
          'wide.py', 'why-brief.md', 'novel.py', 'checkcls.py', 'sizes.py', 'tables.py', 'verify.py']:
    shutil.copy(os.path.join('/tmp/ccland', f), tools)
for src, name in [('t2/families-all.json', 'families-all.json'), ('novel-groups.json', 'novel-groups.json'),
                  ('t2/novel-groups.json', 'novel-groups-tail.json')]:
    shutil.copy(os.path.join('/tmp/ccland', src), os.path.join(tools, name))
print('wrote', len(tsv) - 1, 'rows; motives', motives.most_common(20))
