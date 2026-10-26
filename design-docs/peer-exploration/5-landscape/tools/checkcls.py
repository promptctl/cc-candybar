"""Check every classifier output under a run's cls/ against its input: line count, ids in order, label shape.

usage: CCLAND_RUN=<dir> checkcls.py [prefix ...]   (prefixes: '' features, why, nov)
"""
import glob, os, re, sys
from collections import Counter

RUN = os.environ.get('CCLAND_RUN', '/tmp/ccland')
LABEL = {'': r'^(F\d\d|other: .+)$', 'why': r'^(M\d\d|other: .+)$', 'nov': r'^(unusual|common)\b'}
for pre in sys.argv[1:] or ['']:
    p = pre + '-' if pre else ''
    for inp in sorted(glob.glob('%s/cls/%sin-*.tsv' % (RUN, p))):
        out = inp.replace('%sin-' % p, '%sout-' % p)
        ids = [l.split('\t', 1)[0] for l in open(inp)]
        if not os.path.exists(out):
            print('MISSING', out); continue
        got = [l.rstrip('\n').split('\t') for l in open(out) if l.strip()]
        bad = [g for g in got if len(g) < 2 or not re.match(LABEL[pre], g[1].strip())]
        order = [g[0].strip() for g in got] == ids
        print('%s %d/%d in-order=%s bad-labels=%d %s' % (os.path.basename(out), len(got), len(ids), order, len(bad),
                                                        bad[:2] if bad else ''))
