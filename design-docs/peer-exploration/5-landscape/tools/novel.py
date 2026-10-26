"""Group the screen's unusual items into idea patterns; projects per pattern."""
import json, glob, re
import os
RUN = os.environ.get('CCLAND_RUN', '/tmp/ccland')  # the top-1,000 run, or t2 for the wider read
from collections import defaultdict

o = json.load(open(RUN + '/other.json'))
unusual = []
for f in sorted(glob.glob(RUN + '/cls/nov-out-*.tsv')):
    for l in open(f):
        p = l.rstrip('\n').split('\t', 2)
        if len(p) >= 2 and p[1] == 'unusual':
            proj, c, it = o[int(p[0])]
            unusual.append((proj, it, p[2] if len(p) > 2 else ''))
PAT = [  # first match wins, so the narrow patterns come before the broad ones
    ('practice or study in the bar (flashcards, language drills)', r'flashcard|leitner|sm-2|spaced|vocab|polyglot'),
    ('predicts how long the work will take', r'\beta\b|finish time|remaining-time|remaining estimate|quantile|survival model|median duration'),
    ('grades the prompt or the reply', r'prompt-rater|grade of the last prompt|please and thank|hedge words|certainty score|complexity score|judge|quality score|xp for'),
    ('shows friends or other users', r'friends|presence|cohort|leaderboard'),
    ('feeds the bar\'s numbers back to Claude or gates it', r'guard|gate|block|denies|deny|park|pause|holds|rewake|wake|resume|continue|mcp|tells the (running )?agent|into the model|context with|inject|exit 2|keep-working|instruction|steer|relaunch|bridge file|hook reads|enforcing hook|warning hook|usage-stop|warns claude|re-prompt|re-asks|keystrokes|systemmessage|prompt context|handoff|asks claude'),
    ('LLM-written text about the session', r'haiku|claude -p|sonnet|llm|gpt|ollama|openai|gemini|model call|forked model|forking the conversation|generated|ai-generated|narrator|quip|joke'),
    ('reads mood, fatigue or personality', r'emotion|mood|fatigue|desperat|frustration|personality|circadian|prompt-quality|self-report|behaviour'),
    ('detects a failure mode in the session', r'loop|re-read|waste|violation|secret|drift|crash|failed build|collision|canary|stale-429|destructive'),
    ('turns the bar into another medium (game, reader)', r'golf|book|arcade|doom|game|high score'),
    ('patches Claude Code itself or its traffic', r'patch|binary|intercept|re-signs|rewrites claude code|cli\.js|spinner text|pty'),
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
json.dump({k: sorted(v) for k, v in groups.items()}, open(RUN + '/novel-groups.json', 'w'), indent=1)
json.dump(ex, open(RUN + '/novel-ex.json', 'w'), indent=1)
for x in ex['unsorted']:
    print('  ', x)
