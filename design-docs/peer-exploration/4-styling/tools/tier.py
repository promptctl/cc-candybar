import json, collections

def n(sig, k):
    return sig.get(k, {}).get("count", 0) if isinstance(sig.get(k), dict) else 0

recs = [json.loads(l) for l in open("/tmp/ccsl/signals.jsonl")]
C = collections.Counter
stats = C()
tiers = collections.defaultdict(list)
rows = []
for r in recs:
    if r.get("status") != "ok":
        stats["status:" + r.get("status", "?").split(":")[0]] += 1
        continue
    ev = r.get("claude_evidence", {})
    relevant = bool(ev.get("fields")) or ev.get("statusLine_setting")
    s = r.get("signals", {})
    fg = {d: n(s, "color.fg_" + d) for d in ("16", "256", "truecolor")}
    bg = {d: n(s, "color.bg_" + d) for d in ("16", "256", "truecolor")}
    anycolor = sum(fg.values()) + sum(bg.values()) + n(s, "color.unclassified") + sum(s.get("color_via", {}).values()) if isinstance(s.get("color_via"), dict) else 0
    th = r.get("themes", {})
    nthemes = len(set(th.get("from_paths", [])) | set(th.get("named_in_content", [])))
    themed = r.get("theme_paths", {}).get("count", 0) > 0 or nthemes >= 2 or n(s, "theme.key") > 0
    cfgcolor = n(s, "named_color_keys") >= 3
    stars = (r.get("meta") or {}).get("stars") or 0
    row = dict(key=r["key"], stars=stars, relevant=relevant, color=anycolor > 0,
               fill=sum(bg.values()) > 0, depth=max([d for d in ("16", "256", "truecolor") if fg[d] + bg[d]] or ["-"], key=lambda d: {"-": 0, "16": 1, "256": 2, "truecolor": 3}[d]),
               powerline=n(s, "glyph.powerline") > 0, nerd=n(s, "glyph.nerd") > 0, themed=themed, nthemes=nthemes,
               cfgcolor=cfgcolor, nocolor=n(s, "env.NO_COLOR") > 0, colorterm=n(s, "env.COLORTERM") > 0,
               lightdark=bool(r.get("lightdark", {}).get("detection")) or n(s, "lightdark.osc11") > 0)
    rows.append(row)
    if not relevant:
        tier = "irrelevant"
    elif themed or cfgcolor:
        tier = "system"
    elif row["color"]:
        tier = "hardcoded"
    else:
        tier = "nocolor"
    row["tier"] = tier
    tiers[tier].append(row)

print("non-ok:", dict(stats))
for t, v in tiers.items():
    print(t, len(v))
rel = [r for r in rows if r["relevant"]]
print("relevant", len(rel))
for f in ("color", "fill", "powerline", "nerd", "themed", "cfgcolor", "nocolor", "colorterm", "lightdark"):
    print(f, sum(r[f] for r in rel))
print("depth", C(r["depth"] for r in rel))
sysrows = sorted(tiers["system"], key=lambda r: -r["stars"])
print("system by stars>=10:", sum(r["stars"] >= 10 for r in sysrows), " >=1:", sum(r["stars"] >= 1 for r in sysrows))
json.dump(rows, open("/tmp/ccsl/rows.json", "w"))
