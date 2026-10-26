"""Group the screen's unusual items into idea patterns; projects per pattern."""
import json, glob, re
from collections import defaultdict

o = json.load(open('/tmp/ccland/other.json'))
unusual = []
for f in sorted(glob.glob('/tmp/ccland/cls/nov-out-*.tsv')):
    for l in open(f):
        p = l.rstrip('\n').split('\t', 2)
        if len(p) >= 2 and p[1] == 'unusual':
            proj, c, it = o[int(p[0])]
            unusual.append((proj, it, p[2] if len(p) > 2 else ''))
PAT = [
    ('feeds the bar\'s numbers back to Claude or gates it', r'guard|gate|block|denies|deny|park|pause|holds|rewake|wake|resume|continue|mcp|tells the (running )?agent|into the model|context with|inject|exit 2|keep-working|instruction|steer|relaunch'),
    ('LLM-written text about the session', r'haiku|claude -p|sonnet|llm|gpt|ollama|openai|gemini|model call|forked model|forking the conversation|generated|ai-generated|narrator|quip|joke'),
    ('reads mood, fatigue or personality', r'emotion|mood|fatigue|desperat|frustration|personality|circadian|prompt-quality|self-report|behaviour'),
    ('detects a failure mode in the session', r'loop|re-read|waste|violation|secret|drift|crash|failed build|collision'),
    ('turns the bar into another medium (game, reader)', r'golf|book|arcade|doom|game|high score'),
    ('patches Claude Code itself or its traffic', r'patch|binary|intercept|re-signs'),
]
groups = defaultdict(set)
ex = defaultdict(list)
for proj, it, why in unusual:
    text = it + ' ' + why
    for name, rx in PAT:
        if re.search(rx, text, re.I):
            groups[name].add(proj)
            if len(ex[name]) < 40:
                ex[name].append('%s: %s' % (proj, it[:140]))
            break
    else:
        groups['unsorted'].add(proj)
        ex['unsorted'].append('%s: %s' % (proj, it[:140]))
print(len(unusual), 'unusual items from', len({u[0] for u in unusual}), 'projects')
for k, v in groups.items():
    print('%3d %s' % (len(v), k))
json.dump({k: sorted(v) for k, v in groups.items()}, open('/tmp/ccland/novel-groups.json', 'w'), indent=1)
json.dump(ex, open('/tmp/ccland/novel-ex.json', 'w'), indent=1)
for x in ex['unsorted']:
    print('  ', x)
