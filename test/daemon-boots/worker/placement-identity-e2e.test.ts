// [LAW:behavior-not-structure] A placement's identity and edit mode's own
// state, driven through a daemon as Claude Code sessions click it: a placement
// removed and added back from the library is a new placement, wearing nothing
// of its predecessor's, in every session; edit mode's own keys live and die
// with the edit, whatever ends it; and a menu keyed by its author and a menu
// on a placement of the same name keep separate state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../../../src/render/frame";
import { DOOR_GLYPH } from "../../../src/config/disclosure";
import { isEditModeKey } from "../../../src/config/reserved-names";
import { menuStateKey } from "../../../src/config/menu-keys";
import { decodeLayoutOp } from "../../../src/config/layout-ops";
import { VERB_APPLY_LAYOUT_OP } from "../../../src/click/wire";
import { effectsOf } from "../../helpers/click";
import {
  linksOf,
  startBar,
  type Bar,
  type BarSession,
  type DrawnLink,
} from "../../helpers/drive-bar";
import { startBarDaemon } from "../../helpers/in-worker-daemon";
import { BAR_SESSION_ID as SESSION } from "../../../scripts/lib/hook-data";

jest.setTimeout(60_000);

// A segment with a setting and an author's menu, placed by its name.
const CONFIG = `{
  actions: { applyStyle: { set: "style", from: "styles" } },
  segments: {
    clock: {
      description: "a clock",
      template: 'c{{ .settings.n }} {{ menu "applyStyle" "▸" "▾" }}',
      settings: { n: { label: 'n', domain: { min: 1, max: 3 }, default: 1 } },
    },
    plain: { template: 'plain' },
  },
  root: { h: ['plain', 'clock'] },
}
`;

let dir: string;
let bar: Bar | undefined;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-identity-"));
});
afterEach(async () => {
  await bar?.stop();
  bar = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function barOf(config: string): Promise<Bar> {
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, config);
  bar = await startBar(
    { width: 200, rows: 60, config: file, cwd: dir, ssh: false },
    startBarDaemon,
  );
  await bar.render();
  return bar;
}

// What a restart loads: every edit-mode key stored, by session.
async function storedEditKeys(b: Bar): Promise<string[]> {
  await b.restart();
  return Object.entries(b.stored()).flatMap(([sid, values]) =>
    Object.keys(values)
      .filter(isEditModeKey)
      .map((key) => `${sid} ${key}`),
  );
}

// The ids of the placements a render offers to remove, in its order.
const placementIds = (frame: Frame): string[] =>
  linksOf(frame).flatMap((l) =>
    effectsOf(l.url).flatMap((e) => {
      const op =
        e.verb === VERB_APPLY_LAYOUT_OP
          ? decodeLayoutOp(e.args[3] ?? "")
          : null;
      return op?.op === "remove" ? [op.target] : [];
    }),
  );

const enter = async (s: BarSession): Promise<Frame> => {
  await s.click(DOOR_GLYPH);
  return (await s.click("✎ arrange")).rendered;
};

// Add `seg` from the library the `nth` ✚ opens, paging until it shows.
async function addFromLibrary(
  s: BarSession,
  seg: string,
  nth = 1,
): Promise<Frame> {
  let frame = (await s.click("✚", nth)).rendered;
  for (let page = 0; page < 12; page++) {
    const entry = linksOf(frame).find((l) => l.text.startsWith(`${seg} `));
    if (entry !== undefined) return (await s.follow(entry.url)).rendered;
    frame = (await s.click("→")).rendered;
  }
  throw new Error(`the library never showed ${seg}`);
}

// The bar's own row, the one the author's segments draw on.
const barRow = (frame: Frame): string =>
  textOf(frame)
    .split("\n")
    .find((line) => line.includes("plain"))!;

describe("a placement removed and added back is a new placement", () => {
  test("in edit mode, after it and through undo, in the clicking session and another", async () => {
    const b = await barOf(CONFIG);
    const other = b.session("other");
    await other.render();
    // Both sessions open the clock's menu, and the clicking one drafts a
    // setting on it and opens its configure panel.
    await b.click("▸");
    await other.click("▸");
    await enter(b);
    await b.click("🔧", 2);
    expect(textOf((await b.click("▶", 2)).rendered)).toContain("n 2");
    await b.click("✖", 3);
    let frame = await addFromLibrary(b, "clock", 2);
    const [, fresh] = placementIds(frame);
    expect(fresh).toMatch(/^clock-[0-9a-f]{6}$/);
    // In edit mode: no configure panel, and the live bar draws it clean.
    expect(textOf(frame)).not.toContain("◀ n");
    frame = (await b.click("☐ live")).rendered;
    expect(textOf(frame)).toContain("c1 ▸");
    expect(textOf(frame)).not.toContain("▾");
    // Through undo and redo: the redone insert is the same clean placement.
    await b.click("↶");
    frame = (await b.click("↷")).rendered;
    expect(placementIds(frame)).toEqual(["plain", fresh]);
    expect(textOf(frame)).toContain("c1 ▸");
    // After it: saved, and clean in both sessions.
    frame = (await b.click("✓ save")).rendered;
    expect(fs.readFileSync(b.configPath, "utf8")).toContain(
      `{ seg: "clock", id: "${fresh}" }`,
    );
    expect(barRow(frame)).toContain("c1 ▸");
    expect(barRow(await other.render())).toContain("c1 ▸");
    expect(await storedEditKeys(b)).toEqual([]);
  });

  test("an authored id keeps its state: undoing the removal brings the placement back as it was", async () => {
    const b = await barOf(CONFIG);
    await b.click("▸");
    await enter(b);
    await b.click("✖", 3);
    await b.click("✓ save");
    const frame = (await b.click("↶")).rendered;
    expect(fs.readFileSync(b.configPath, "utf8")).toBe(CONFIG);
    expect(barRow(frame)).toContain("c1 ▾");
  });
});

describe("edit mode leaves nothing behind", () => {
  const leaves: ReadonlyArray<readonly [string, (b: Bar) => Promise<unknown>]> =
    [
      ["save", async (b) => await b.click("✓ save")],
      ["cancel", async (b) => await b.click("↩ cancel")],
      ["done", async (b) => await b.click("✎ done")],
      ["closing the door", async (b) => await b.click("✖", 1)],
      ["a restart", async () => {}],
    ];
  test.each(leaves)(
    "leaving by %s stores no edit-mode key",
    async (_how, leave) => {
      const b = await barOf(CONFIG);
      await enter(b);
      await b.click("☐ live");
      await b.click("🔧", 2);
      await b.click("▶", 2);
      await b.click("✚", 1);
      await leave(b);
      expect(await storedEditKeys(b)).toEqual([]);
      expect(textOf(await b.render())).not.toContain("✓");
    },
  );

  test("a restart over a store an older build left edit-mode keys in loads none", async () => {
    const b = await barOf(CONFIG);
    await b.restart((stored) => ({
      ...stored,
      [SESSION]: {
        ...stored[SESSION],
        "edit.mode": "arrange",
        "edit.live": "open",
      },
    }));
    expect(textOf(await b.render())).not.toContain("✓");
    expect(await storedEditKeys(b)).toEqual([]);
  });
});

describe("cancel drops every session write the edit held", () => {
  test("author menus return as they were, and a menu on a cancelled placement leaves nothing", async () => {
    const b = await barOf(CONFIG);
    await b.click("▸");
    await enter(b);
    await b.click("☐ live");
    let frame = await addFromLibrary(b, "clock", 1);
    const [fresh] = placementIds(frame).filter(
      (id) => id !== "plain" && id !== "clock",
    );
    // The original's menu closed and the new placement's opened, in the edit.
    frame = (await b.click("▾")).rendered;
    frame = (await b.click("▸", 1)).rendered;
    expect(textOf(frame)).toContain("▾");
    frame = (await b.click("↩ cancel")).rendered;
    expect(barRow(frame)).toContain("c1 ▾");
    expect(fs.readFileSync(b.configPath, "utf8")).toBe(CONFIG);
    await b.restart();
    const keys = Object.values(b.stored()).flatMap((v) => Object.keys(v));
    expect(keys).toContain(menuStateKey("clock", "applyStyle", undefined));
    expect(keys).not.toContain(menuStateKey(fresh!, "applyStyle", undefined));
  });
});

describe("a write to an edit-mode key with no edit open", () => {
  test("a stale click from an older render leaves nothing stored", async () => {
    const b = await barOf(CONFIG);
    const arranged = await enter(b);
    const live: DrawnLink = linksOf(arranged).find((l) => l.text === "☐ live")!;
    await b.click("✓ done");
    const clicked = await b.stale(live);
    expect(textOf(clicked.rendered)).not.toContain("✓ done");
    expect(await storedEditKeys(b)).toEqual([]);
  });
});

describe("an author's menu key and a placement's id never share state", () => {
  test(`a menu keyed "s" and a menu on a placement with id "s" open apart`, async () => {
    const b = await barOf(`{
      actions: { applyStyle: { set: "style", from: "styles" } },
      segments: {
        keyed: { template: 'k {{ menu "applyStyle" "▸" "▾" (dict "key" "s") }}' },
        clock: { template: 'c {{ menu "applyStyle" "▸" "▾" }}' },
      },
      root: { h: ['keyed', { seg: 'clock', id: 's' }] },
    }`);
    let row = textOf(await b.render());
    expect(row).toContain("k ▸");
    expect(row).toContain("c ▸");
    row = textOf((await b.click("▸", 2)).rendered);
    expect(row).toContain("k ▸");
    expect(row).toContain("c ▾");
    row = textOf((await b.click("▸", 1)).rendered);
    expect(row).toContain("k ▾");
    expect(row).toContain("c ▾");
  });
});
