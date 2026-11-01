// The three choices the page compares, each a name the colour model's tables
// hold (src/themes/decor.ts): a jump is a row of SHADES, and a keystone
// placement with an open-menu lineage is a row of VARIATIONS named
// `<keystone>-<open>`. The labels are the page's; the ids are the tables'.
// Harness for brandon-menus-sjhy.4fi.
export const JUMPS = [
  { id: "middle", label: "one rung (now) — d1 · base · l1" },
  { id: "wide", label: "two rungs — d2 · base · l2" },
  { id: "widest", label: "three rungs — d3 · base · l3" },
  { id: "pair", label: "two-tone, four apart — d2 / l2 strictly alternating" },
  { id: "pair-wide", label: "two-tone, six apart — d3 / l3 strictly alternating" },
];
export const KEYSTONES = [
  { id: "door", label: "🍫 only — the bar's first cell" },
  { id: "start", label: "first cell of each line" },
  { id: "end", label: "last cell of each line" },
  { id: "ends", label: "first and last cell of each line" },
];
export const OPENS = [
  { id: "primary", label: "primary, at every depth" },
  { id: "secondary", label: "secondary, at every depth" },
  { id: "alternate", label: "primary ⇄ secondary, stepping by depth" },
];
export const STATES = [
  { id: "calm", label: "calm" },
  { id: "working", label: "working (activity cell shown)" },
  { id: "hot", label: "hot (alerts on)" },
];
export const THEMES = [
  "textual-dark", "textual-light", "nord", "gruvbox", "catppuccin-mocha", "catppuccin-latte",
  "dracula", "rose-pine", "rose-pine-dawn", "solarized-light", "tokyo-night", "flexoki",
];
/** The VARIATIONS row a keystone placement and an open lineage name. */
export const variationOf = (keystone, open) => `${keystone}-${open}`;
