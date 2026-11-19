// [LAW:verifiable-goals] Edit chrome's state — the ✚ libraries and their
// pages, the configure panel and its lists, the help pane, ☐ live — is the
// open edit's own. A placement the edit ends takes its chrome with it, and its
// author menus, so one re-added under the same id opens fresh; and an edit
// that ends, by any route, leaves no chrome state behind, in the bar or in the
// stored sessions. Driven as a user drives the bar: each click a link the bar
// drew, on a daemon in this worker.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DISCLOSURE_CLOSED, DOOR_GLYPH } from "../../../src/config/disclosure";
import { escapedIdent } from "../../../src/config/ident";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_KEY,
} from "../../../src/config/loader/edit-mode";
import { EDIT_NS } from "../../../src/config/reserved-names";
import { SESSION_SWEEP_MS } from "../../../src/daemon/collector";
import { textOf, type Frame } from "../../../src/render/frame";
import { loggedWhen } from "../../helpers/daemon-log";
import {
  describeLink,
  linksOf,
  startBar,
  type Bar,
  type StartBarDaemon,
} from "../../helpers/drive-bar";
import { heldClock, type HeldClock } from "../../helpers/held-clock";
import { startBarDaemon, startDaemon } from "../../helpers/in-worker-daemon";
import { effectsOf } from "../../../src/click/read";

jest.setTimeout(60_000);

// `clock` and `clock-2` are two placements of one segment, each hosting an
// author menu; the library's ✚ re-mints `clock-2` while `clock` is placed.
const CONFIG = `{
  actions: { pick: { set: 'theme', from: 'themes' } },
  segments: {
    clock: { template: 'CLOCK {{ menu "pick" "PICK" "KCIP" }}' },
    tag: { template: 'TAG' },
  },
  root: { h: ['tag', 'clock', { seg: 'clock', id: 'clock-2' }] },
}
`;
const P = "clock-2";

const writeConfig = (text: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-chrome-"));
  const file = path.join(dir, "config.json5");
  fs.writeFileSync(file, text);
  return file;
};

let bar: Bar | undefined;
afterEach(async () => {
  await bar?.stop();
  bar = undefined;
});

const open = async (
  config: string = CONFIG,
  start: StartBarDaemon = startBarDaemon,
): Promise<Driver> => {
  bar = await startBar(
    { width: 220, rows: 80, config: writeConfig(config), cwd: process.cwd(), ssh: false },
    start,
  );
  return driver(bar, await bar.render());
};

interface Driver {
  readonly bar: Bar;
  last(): Frame;
  // Click the first drawn link, its text `label` if one is named, a click on
  // which does what `does` matches.
  click(does: RegExp, label?: string): Promise<void>;
  text(label: string): Promise<void>;
  render(): Promise<void>;
}

function driver(b: Bar, first: Frame): Driver {
  let last = first;
  return {
    bar: b,
    last: () => last,
    click: async (does, label) => {
      const hit = linksOf(last).find(
        (l) =>
          does.test(describeLink(l)) && (label === undefined || l.text === label),
      );
      if (hit === undefined)
        throw new Error(`no drawn link does ${does} in:\n${textOf(last)}`);
      const { refused, rendered } = await b.follow(hit.url);
      if (refused !== null) throw new Error(`refused: ${refused}`);
      last = rendered;
    },
    text: async (label) => {
      const { refused, rendered } = await b.click(label);
      if (refused !== null) throw new Error(`refused: ${refused}`);
      last = rendered;
    },
    render: async () => {
      last = await b.render();
    },
  };
}

// An open disclosure draws its own closer, so what is open on the bar is the
// set of keys some drawn link writes closed.
function openKeys(frame: Frame): string[] {
  return [
    ...new Set(
      linksOf(frame)
        .flatMap((l) => effectsOf(l.url))
        .filter((e) => e.verb === "set-state" && e.args[2] === DISCLOSURE_CLOSED)
        .map((e) => e.args[1]!),
    ),
  ].sort();
}

const X = escapedIdent(P);
const ESCAPED_EDIT = escapedIdent(EDIT_NS);
// What a ✚'s menu key holds of the gap after `id`, however it is nested.
const gapOf = (id: string): string =>
  escapedIdent(`insertSeg.after.${escapedIdent(id)}`);
// What is open about placement P: its ✚, its configure panel and lists, and
// its author menus.
const openOn = (frame: Frame): string[] =>
  openKeys(frame).filter(
    (k) => k.includes(gapOf(P)) || k.includes(X) || k === EDIT_CONFIGURE_KEY,
  );
// What is open of edit chrome anywhere on the bar.
const chromeOpen = (frame: Frame): string[] =>
  openKeys(frame).filter(
    (k) => k !== EDIT_MODE_KEY && (k.startsWith(EDIT_NS) || k.includes(ESCAPED_EDIT)),
  );

const words = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const ARRANGE = /set-state <session> edit\.mode arrange$/;
// The ✚ after `id`, its library's next page, and its closer.
const insertAfter = (id: string): RegExp =>
  new RegExp(`^set-state <session> menus\\.\\S*${gapOf(id)}\\S* edit\\.`);
const nextPage = (id: string): RegExp =>
  new RegExp(`^set-state <session> menupages\\.\\S*${gapOf(id)}\\S* [1-9]\\d*$`);
const closeGap = (id: string): RegExp =>
  new RegExp(`^set-state <session> menus\\.\\S*${gapOf(id)}\\S* closed`);
const removeOf = (id: string): RegExp => new RegExp(`apply-layout-op .* remove:${id}$`);
const configure = (preset: string, id: string): RegExp =>
  words(`set-state <session> ${EDIT_CONFIGURE_KEY} ${configureMember(preset, id)}`);

async function arrange(d: Driver): Promise<void> {
  if (!linksOf(d.last()).some((l) => ARRANGE.test(describeLink(l)))) await d.text(DOOR_GLYPH);
  await d.click(ARRANGE);
}

// Insert `clock` from the ✚ after `tag`: the library opens on its first page,
// and `clock` is on its last.
async function insertFrom(d: Driver, gap: string, name: string): Promise<void> {
  if (!openKeys(d.last()).some((k) => k.includes(gapOf(gap))))
    await d.click(insertAfter(gap));
  const insert = new RegExp(`insert:${name}:${gap}:after$`);
  while (!linksOf(d.last()).some((l) => insert.test(describeLink(l))))
    await d.click(nextPage(gap), "→");
  await d.click(insert);
  // Its library is the gap's, not the placement's: close it.
  await d.click(closeGap(gap));
}
const insertClock = (d: Driver): Promise<void> => insertFrom(d, "tag", "clock");

// Open everything chrome holds for P under `preset`: its ✚ on page two, its
// configure panel with the theme list open, and its author menu.
async function dirty(d: Driver, preset = "default"): Promise<void> {
  await d.click(insertAfter(P));
  await d.click(nextPage(P), "→");
  await d.click(configure(preset, P));
  await d.click(new RegExp(`set-state <session> edit\\.list\\.\\S*d${X} \\S*\\.theme ;`));
  await d.click(words(`set-state <session> menus.${X}.pick pick`));
  expect(openOn(d.last())).toHaveLength(4);
}

// P, re-added, opens with nothing from before: no menu, panel or page, but
// what a placement that never ended still holds (`kept`).
async function expectFresh(
  d: Driver,
  preset = "default",
  kept: readonly string[] = [],
): Promise<void> {
  const fresh = (): string[] =>
    openOn(d.last()).filter((k) => !kept.includes(k));
  expect(textOf(d.last())).toContain(`✖ ${P} 🔧`);
  expect(fresh()).toEqual([]);
  await d.click(insertAfter(P));
  expect(textOf(d.last())).not.toMatch(/ 2\/\d+ /);
  await d.click(configure(preset, P));
  const opened = fresh();
  expect(opened).toHaveLength(2);
  expect(opened).toContain(EDIT_CONFIGURE_KEY);
  expect(opened.find((k) => k !== EDIT_CONFIGURE_KEY)).toContain(gapOf(P));
}

describe("a placement the edit ends takes its chrome and its menus with it", () => {
  test("remove then re-add in one edit", async () => {
    const d = await open();
    await arrange(d);
    await dirty(d);
    await d.click(removeOf(P));
    expect(openOn(d.last())).toEqual([]);
    await insertClock(d);
    await expectFresh(d);
  });

  test("remove, save, re-add in a later edit", async () => {
    const d = await open();
    await arrange(d);
    await dirty(d);
    await d.click(removeOf(P));
    await d.text("✓ save");
    await arrange(d);
    await insertClock(d);
    await expectFresh(d);
  });

  test("undo of an insert, then insert again", async () => {
    const d = await open();
    await arrange(d);
    await d.click(removeOf(P));
    await insertClock(d);
    await dirty(d);
    await d.text("↶");
    expect(textOf(d.last())).not.toContain(`✖ ${P} 🔧`);
    await insertClock(d);
    await expectFresh(d);
  });

  test("redo of a removal", async () => {
    const d = await open();
    await arrange(d);
    await d.click(removeOf(P));
    await d.text("↶");
    await dirty(d);
    await d.text("↷");
    expect(textOf(d.last())).not.toContain(`✖ ${P} 🔧`);
    await insertClock(d);
    await expectFresh(d);
  });

  test("reset layout, then its undo", async () => {
    const d = await open();
    await arrange(d);
    await dirty(d);
    await d.text("↺ reset layout");
    expect(textOf(d.last())).not.toContain(`✖ ${P} 🔧`);
    await d.text("↶");
    await expectFresh(d);
  });

  test("delete then recreate a preset", async () => {
    const d = await open();
    await arrange(d);
    await d.text("📐 layout");
    await d.text("+ preset");
    await dirty(d, "custom-1");
    await d.text("▦ preset");
    await d.text("🚮 delete custom-1");
    await d.text("+ preset");
    // An author menu keys by placement id, and `default`'s clock-2 never
    // ended: its menu is that placement's, open as it was left.
    await expectFresh(d, "custom-1", [`menus.${X}.pick`]);
  });

  test("an undo of a removal restores the placement's drafts", async () => {
    const d = await open();
    await arrange(d);
    await d.click(configure("default", P));
    await d.click(/^set-state <session> edit\.draft\.default\.clock-2\.effect wheel$/);
    await d.click(removeOf(P));
    await d.text("↶");
    // The draft is back: save writes it into the placement.
    await d.text("✓ save");
    expect(fs.readFileSync(d.bar.configPath, "utf8")).toMatch(
      /id: ['"]clock-2['"], settings: \{ effect: "wheel" \}/,
    );
  });
});

// ◁ counts what the edit holds open: each step back closes the last thing
// the edit opened, and none is skipped for being chrome. The door is opened
// before a restart, so it is no step back, and every step is the edit's.
test("◁ steps back through what the edit opened", async () => {
  const d = await open();
  await d.text(DOOR_GLYPH);
  await d.bar.restart();
  await d.render();
  await arrange(d);
  await d.click(insertAfter(P));
  await d.click(nextPage(P), "→");
  await d.click(configure("default", P));
  expect(openOn(d.last())).toHaveLength(2);
  await d.text("◁");
  expect(openOn(d.last())).toEqual([openOn(d.last())[0]]);
  expect(openOn(d.last())[0]).toContain(gapOf(P));
  await d.text("◁");
  expect(textOf(d.last())).toMatch(/ 1\/\d+ /);
  await d.text("◁");
  expect(openOn(d.last())).toEqual([]);
});

describe("a segment inserted twice from the library loads and works", () => {
  test.each(["edit", "edit-sort"])("named %s, hosting a menu", async (name) => {
    const d = await open(`{
      actions: { pick: { set: 'theme', from: 'themes' } },
      segments: { '${name}': { template: 'SEG {{ menu "pick" "PICK" "KCIP" }}' } },
      root: { h: ['${name}'] },
    }
    `);
    await arrange(d);
    await insertFrom(d, name, name);
    await insertFrom(d, name, name);
    await d.text("✓ save");
    expect(textOf(d.last())).not.toContain("⚠");
    expect(textOf(d.last()).split("SEG PICK")).toHaveLength(4);
    await d.click(words(`set-state <session> menus.${escapedIdent(`${name}-2`)}.pick pick`));
    expect(openKeys(d.last())).toContain(`menus.${escapedIdent(`${name}-2`)}.pick`);
  });
});

// The stored sessions hold no key edit chrome mints.
function storedChrome(b: Bar): string[] {
  const stored = JSON.parse(
    fs.readFileSync(path.join(b.stateDir, "session-state.json"), "utf8"),
  ) as unknown;
  const keys: string[] = [];
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    for (const [k, inner] of Object.entries(v)) {
      keys.push(k);
      walk(inner);
    }
  };
  walk(stored);
  return keys.filter((k) => k.startsWith(EDIT_NS) || k.includes(ESCAPED_EDIT));
}

// Open what edit chrome holds across the bar: P's chrome, the help pane, and
// ☐ live.
async function dirtyAll(d: Driver): Promise<void> {
  await dirty(d);
  await d.text("(?)");
  await d.text("☐ live");
  expect(chromeOpen(d.last()).length).toBeGreaterThanOrEqual(5);
}

async function expectNoChrome(d: Driver): Promise<void> {
  await d.render();
  await arrange(d);
  expect(chromeOpen(d.last())).toEqual([]);
  expect(textOf(d.last())).toContain("☐ live");
  await d.bar.restart();
  expect(storedChrome(d.bar)).toEqual([]);
}

describe("an edit that ends, by any route, leaves no chrome state", () => {
  test.each([
    ["save", async (d: Driver) => {
      await d.click(removeOf("tag"));
      await d.text("✓ save");
    }],
    ["cancel", async (d: Driver) => {
      await d.click(removeOf("tag"));
      await d.text("↩ cancel");
    }],
    ["the toggle", (d: Driver) => d.text("✎ done")],
    ["the settings menu closing", (d: Driver) => d.click(/set-state <session> candybar\.menu closed/)],
    ["a config-origin move", async (d: Driver) => {
      d.bar.moveConfig();
      await d.render();
    }],
  ])("%s", async (_route, leave) => {
    const d = await open();
    await arrange(d);
    await dirtyAll(d);
    await leave(d);
    await expectNoChrome(d);
  });

  test("a restart mid-edit", async () => {
    const d = await open();
    await arrange(d);
    await dirtyAll(d);
    await d.bar.restart();
    expect(storedChrome(d.bar)).toEqual([]);
    await expectNoChrome(d);
  });

  describe("on a held clock", () => {
    let clock: HeldClock;
    let env: NodeJS.ProcessEnv;
    const held: StartBarDaemon = async (e) => {
      env = e;
      const daemon = startDaemon(e, { clock });
      return { target: daemon, stop: daemon.stop };
    };
    beforeEach(() => {
      clock = heldClock(new Date());
    });

    test("the idle timeout", async () => {
      const d = await open(CONFIG, held);
      await arrange(d);
      await dirtyAll(d);
      await clock.settle(120_000);
      await loggedWhen(env, (lines) => lines.some((l) => l.includes("menu-idle: closed=")), "the idle close");
      await expectNoChrome(d);
    });

    test("the session's retire", async () => {
      const d = await open(CONFIG, held);
      await arrange(d);
      await dirtyAll(d);
      clock.advance(2 * SESSION_SWEEP_MS);
      await loggedWhen(env, (lines) => lines.some((l) => l.includes("session retired")), "the retire");
      await expectNoChrome(d);
    });
  });
});
