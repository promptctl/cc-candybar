// node proto-looks/build.mjs — proto-looks/out/renders.json → proto-looks/accent-looks.html (self-contained).
import fs from "node:fs";
import { JUMPS, KEYSTONES, OPENS, STATES, THEMES, variationOf } from "./axes.mjs";
const OUT = "proto-looks/out";
const colours = [], colourIdx = new Map();
const idx = (rgb) => {
  if (rgb === null) return -1;
  if (!colourIdx.has(rgb)) { colourIdx.set(rgb, colours.length); colours.push(rgb); }
  return colourIdx.get(rgb);
};
const hex = (r, g, b) => "#" + [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
// One row of SGR-styled text → runs [text, fg, bg, flags]; flags: 1 bold, 2 dim, 4 italic, 8 underline, 16 reverse.
function runsOf(row) {
  const text = row.replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
  const runs = [];
  let fg = null, bg = null, flags = 0, at = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  const push = (t) => { if (t) runs.push([t, idx(fg), idx(bg), flags]); };
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    push(text.slice(at, m.index));
    at = re.lastIndex;
    const c = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < c.length; i++) {
      const n = c[i];
      if (n === 0) { fg = null; bg = null; flags = 0; }
      else if (n === 1) flags |= 1; else if (n === 2) flags |= 2; else if (n === 3) flags |= 4;
      else if (n === 4) flags |= 8; else if (n === 7) flags |= 16;
      else if (n === 22) flags &= ~3; else if (n === 23) flags &= ~4; else if (n === 24) flags &= ~8; else if (n === 27) flags &= ~16;
      else if (n === 39) fg = null; else if (n === 49) bg = null;
      else if ((n === 38 || n === 48) && c[i + 1] === 2 && c.length >= i + 5) { const v = hex(c[i + 2], c[i + 3], c[i + 4]); if (n === 38) fg = v; else bg = v; i += 4; }
      // [LAW:no-silent-failure] an SGR code this page cannot draw would show a wrong colour as the look.
      else throw new Error(`unhandled SGR ${n} in ${JSON.stringify(m[0])}`);
    }
  }
  push(text.slice(at));
  if (/\x1b/.test(runs.map((r) => r[0]).join(""))) throw new Error("escape left in text");
  return runs;
}
const picture = ({ text }) => ({ rows: text.split("\n").map(runsOf) });
const drawn = JSON.parse(fs.readFileSync(`${OUT}/renders.json`, "utf8"));
const taken = new Set();
const take = (from, key) => {
  const r = from[key];
  if (r === undefined) throw new Error(`no render ${key}`);
  taken.add(key);
  return { closed: picture(r.closed), open: picture(r.open) };
};
const renders = {}, reference = {}, poles = {};
for (const t of THEMES) {
  poles[t] = { bg: drawn.poles[t].background, fg: drawn.poles[t].foreground };
  for (const s of STATES) {
    reference[`${s.id}.${t}`] = take(drawn.today, `${s.id}|${t}`);
    for (const j of JUMPS) for (const k of KEYSTONES) for (const o of OPENS)
      renders[`${j.id}.${k.id}.${o.id}.${s.id}.${t}`] = take(drawn.renders, `${variationOf(k.id, o.id)}|${j.id}|${s.id}|${t}`);
  }
}
// [LAW:one-source-of-truth] The axes label the colour model's trial rows; a row
// render.ts drew that no axis names is a candidate the page would never show.
const unplaced = Object.keys(drawn.renders).filter((key) => !taken.has(key));
if (unplaced.length > 0) throw new Error(`rendered but on no axis: ${unplaced.slice(0, 5).join(", ")} (${unplaced.length})`);
const data = { jumps: JUMPS, keystones: KEYSTONES, opens: OPENS, states: STATES, themes: THEMES, colours, poles, renders, reference };
const fonts = JSON.parse(fs.readFileSync("proto-looks/fonts.json", "utf8"));
const page = fs.readFileSync("proto-looks/template.html", "utf8")
  .replace("__FONT_REGULAR__", fonts.Regular).replace("__FONT_BOLD__", fonts.Bold)
  .replace("__DATA__", () => JSON.stringify(data));
fs.writeFileSync("proto-looks/accent-looks.html", page);
console.log(`proto-looks/accent-looks.html: ${Object.keys(renders).length} renders, ${colours.length} colours, ${(page.length / 1e6).toFixed(1)} MB`);
