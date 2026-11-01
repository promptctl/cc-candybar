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
// flags: 1 bold, 2 dim, 4 italic, 8 underline, 16 reverse.
const FLAGS = { bold: 1, dim: 2, italic: 4, underline: 8, reverse: 16 };
// [LAW:no-silent-failure] a colour or attribute this page cannot draw would show a wrong look.
const colourOf = (colour) => {
  if (colour === undefined || colour === "default") return idx(null);
  if (!/^#[0-9a-f]{6}$/.test(colour)) throw new Error(`unhandled colour ${colour}`);
  return idx(colour);
};
const flagsOf = (attrs = []) =>
  attrs.reduce((flags, name) => {
    if (FLAGS[name] === undefined) throw new Error(`unhandled attribute ${name}`);
    return flags | FLAGS[name];
  }, 0);
// One row of a Frame → runs [text, fg, bg, flags].
const runsOf = ({ runs }) =>
  runs.filter(({ text }) => text !== "").map(({ text, fg, bg, attrs }) => [text, colourOf(fg), colourOf(bg), flagsOf(attrs)]);
const picture = ({ rows }) => ({ rows: rows.map(runsOf) });
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
