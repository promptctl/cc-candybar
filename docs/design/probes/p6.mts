import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
const W = "/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind";
const { startBar, drawnLinks, describeLink } = await import(`${W}/test/helpers/drive-bar.ts`);

const tmp = fs.realpathSync(os.tmpdir());
const before = new Set(fs.readdirSync(tmp));
const bar = await startBar({ config: null, cwd: W, width: 140, rows: 40, ssh: false });
const roots = fs.readdirSync(tmp).filter((n) => !before.has(n) && n.startsWith("ccb-bar")).map((n) => path.join(tmp, n));

const walk = (d: string, out: Map<string, string>) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.set(p, crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"));
  }
  return out;
};
const snap = () => {
  const out = new Map<string, string>();
  for (const r of roots) walk(r, out);
  return out;
};
const shortName = (p: string) => {
  const root = roots.find((r) => p.startsWith(r))!;
  return p.slice(root.length + 1);
};
const diff = (a: Map<string, string>, b: Map<string, string>) =>
  [...b].filter(([k, v]) => a.get(k) !== v).map(([k]) => shortName(k)).filter((n) => !/\.log/.test(n));

let rendered = await bar.render();
const seen = new Map<string, { changed: string[]; refused: string | null; sample: string }>();
const verbsOf = (d: string) => d.split(";").map((e) => e.trim().split(" ")[0]);
const allVerbs = new Set<string>();
let clicks = 0;
for (let i = 0; i < 70; i++) {
  const links = drawnLinks(rendered);
  const described = links.map((l: any) => ({ l, d: describeLink(l) }));
  for (const { d } of described) for (const v of verbsOf(d)) allVerbs.add(v);
  // Prefer a link whose verb set is new, else open something that navigates.
  const next = described.find(({ d }) => !seen.has(verbsOf(d).join("+")));
  const pick = next ?? described[i % described.length];
  if (pick === undefined) break;
  const key = verbsOf(pick.d).join("+");
  const a = snap();
  const res = await bar.follow(pick.l.url).catch((e: unknown) => ({ rendered, refused: `threw ${String(e).slice(0, 120)}` }));
  await new Promise((r) => setTimeout(r, 120));
  const changed = diff(a, snap());
  clicks++;
  rendered = res.rendered;
  const prior = seen.get(key);
  if (prior === undefined) seen.set(key, { changed, refused: res.refused, sample: pick.d.slice(0, 80) });
  else prior.changed = [...new Set([...prior.changed, ...changed])];
}
console.log(
  JSON.stringify(
    {
      clicks,
      verbsSeenInLinks: [...allVerbs].sort(),
      byVerbs: Object.fromEntries(seen),
      files: [...snap().keys()].map(shortName).filter((n) => !/\.log/.test(n)).sort(),
    },
    null,
    1,
  ),
);
bar.stop();
process.exit(0);
