#!/usr/bin/env python3
"""Count the styling taxonomy over the map step's TSV rows.

Usage: tally.py <all.tsv>   (13 columns, see map-brief.md)

Tiers come from the deep file a row was read from: batch-* is the system tier
(read in full), sample-* a seeded random sample of the hardcoded tier, tophard-*
the hardcoded tier's projects with >= 20 stars. Code combinations are counted as
sets, so `fixed+state` and `state+fixed` are one combination.
"""
import sys
from collections import Counter

COLS = ["source", "name", "url", "kind", "seg", "seg_detail", "themes", "depth",
        "fill", "sep", "neighbours", "lightdark", "notable"]
TIERS = {"batch": "system tier (all read)", "sample": "hardcoded tier, random sample",
         "tophard": "hardcoded tier, >=20 stars"}


def codes(field):
    """The leading code word of a field, split on '+', as a set."""
    head = field.strip().split(" ")[0].rstrip(":;,")
    return frozenset(c.rstrip(":;,") for c in head.split("+") if c.rstrip(":;,") not in ("", "-"))


def pct(n, d):
    return f"{n} ({100 * n / d:.0f}%)" if d else str(n)


def section(title, rows, col, top=12):
    d = len(rows)
    print(f"\n### {title} — {COLS[col]} (n={d})")
    single = Counter(c for r in rows for c in codes(r[col]))
    print("any of:", ", ".join(f"{c} {pct(n, d)}" for c, n in single.most_common()))
    combos = Counter("+".join(sorted(codes(r[col]))) or "-" for r in rows)
    print("combinations:", ", ".join(f"{c} {n}" for c, n in combos.most_common(top)))


def themes_line(rows):
    d = len(rows)
    has = [r for r in rows if not r[6].startswith("none") and r[6].strip() != "-"]
    fmt = Counter()
    custom = 0
    for r in has:
        head = r[6].split(" ")[0]
        custom += "+custom" in head
        for part in head.split("+"):
            if ":" in part:
                fmt[part.split(":")[1]] += 1
    print(f"\n### themes (n={d}): bundled themes {pct(len(has), d)}; user-definable {pct(custom, d)}; "
          "format " + ", ".join(f"{k} {v}" for k, v in fmt.most_common()))


def main(path):
    rows = [l.rstrip("\n").split("\t") for l in open(path, encoding="utf-8") if l.strip()]
    bad = [r for r in rows if len(r) != len(COLS)]
    if bad:
        sys.exit(f"{len(bad)} rows without {len(COLS)} columns, first: {bad[0][:2]}")
    print("kind by tier:")
    for t in TIERS:
        k = Counter(r[3] for r in rows if r[0].startswith(t))
        print(f"  {TIERS[t]}: " + ", ".join(f"{a} {b}" for a, b in k.most_common()))
    for t, label in TIERS.items():
        sl = [r for r in rows if r[0].startswith(t) and r[3] == "statusline"]
        print(f"\n## {label}: {len(sl)} statuslines")
        for col in (4, 8, 9, 10, 7, 11):
            section(label, sl, col)
        themes_line(sl)
        filled = [r for r in sl if r[8] in ("bg", "both")]
        for col in (10, 4):
            section(label + ", background-filled only", filled, col)


if __name__ == "__main__":
    main(sys.argv[1])
