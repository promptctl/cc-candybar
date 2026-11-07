// [LAW:no-silent-failure] A value a session holds from an older config: drawn
// as the key's default, stepped from that default, and reported beside the
// door — never shown as one value while its control steps from another
// (src/daemon/foundations/judged-state.ts, Gate.verdict).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { resolveOptionDomain } from "../src/config/option-domain";
import { configOptionDomains } from "../src/config/edit-chrome";
import { doctorReportKeys } from "../src/doctor/report";
import { CHECKS } from "../src/doctor/checks";
import { linksOf } from "../src/click/read";
import { textOf } from "../src/render/frame";
import { listResolvablePaletteNames } from "../src/themes/policy";
import { domainWarning, standingAbout } from "../src/daemon/draw-bar";
import { effectsOf } from "./helpers/click";
import { stateGate } from "./helpers/gates";
import { parseAndValidate } from "./helpers/parse-and-validate";
import { buildRig } from "./helpers/rig";
import { openSettled, SESSION, sessionRig } from "./helpers/session-rig";

const THEMES = new Set(listResolvablePaletteNames());

describe("a stale value of an author's control", () => {
  test("its carousel draws and steps from the key's default, not its first option", () => {
    const rig = buildRig({
      source: `{
        variables: { pick: { kind: 'state', key: 'pick', default: 'b' } },
        actions: {
          choose: { set: 'pick', from: ['a', 'b', 'c'] },
          list: { set: 'listing', to: 'yes' },
        },
        segments: { ring: { template: '[{{ .pick }}] {{ carousel "choose" "list" "the pick" }}' } },
        root: { rows: { identity: { h: ['ring'] }, status: { h: [] } } },
      }`,
      palettes: THEMES,
    });
    rig.sessionState.set(rig.sessionId, "pick", "zz");
    const out = rig.draw().frame;
    expect(textOf(out)).toContain("[b]");
    const writes = (glyph: string) =>
      effectsOf(linksOf(out).find((l) => l.text === glyph)!.url).map((e) =>
        e.args.slice(1),
      );
    expect([writes("◀"), writes("▶")]).toEqual([[["pick", "a"]], [["pick", "c"]]]);
    rig.dispose();
  });

  test("a stepper steps from the default the bar draws, never from a clamp of the stale value", async () => {
    const rig = buildRig({
      source: `{
        variables: { w: { kind: 'state', key: 'w', default: '2' } },
        actions: { up: { set: 'w', min: 1, max: 3, by: 1 } },
        segments: { step: { template: '[{{ .w }}] {{ action "up" "+" }}' } },
        root: { rows: { identity: { h: ['step'] }, status: { h: [] } } },
      }`,
      palettes: THEMES,
    });
    rig.sessionState.set(rig.sessionId, "w", "9");
    const out = rig.draw().frame;
    expect(textOf(out)).toContain("[2]");
    await rig.click(linksOf(out).find((l) => l.text === "+")!.url);
    expect(rig.sessionState.get(rig.sessionId, "w")).toBe("3");
    rig.dispose();
  });
});

describe("the session's foreign values", () => {
  let dir: string;
  let cleanups: Array<() => void>;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-stale-")));
    cleanups = [() => fs.rmSync(dir, { recursive: true, force: true })];
  });
  afterEach(() => {
    for (const fn of cleanups.reverse()) fn();
  });

  test("each stale settings pick is listed with what its key admits; a held one and the daemon's own keys are not", async () => {
    const rig = sessionRig(dir, cleanups);
    const view = await openSettled(rig, dir, cleanups, null);
    expect(view.source.foreign()).toEqual([]);
    rig.sessionState.set(SESSION, "style", "no-such-style");
    rig.sessionState.set(SESSION, "theme", "no-such-theme");
    rig.sessionState.set(SESSION, "preset", "dense");
    rig.sessionState.set(SESSION, "update.dismissed", "0.0.1");
    const foreign = view.source.foreign();
    expect(foreign.map(({ key, held }) => [key, held])).toEqual([
      ["style", "no-such-style"],
      ["theme", "no-such-theme"],
    ]);
    expect(foreign[1]!.admits).toMatch(/"themes"/);
    // A recording takes the session's values as they are stored, so its
    // replay judges the same stale value and draws the same warning.
    expect(view.source.turn().state.values).toMatchObject({
      style: "no-such-style",
    });
    rig.sessionState.clear(SESSION, "style");
    expect(view.source.foreign().map(({ key }) => key)).toEqual(["theme"]);
  });

  test("the bundled bar: every value its controls can write reads back held, and so does a doctor run's report", async () => {
    const config = parseAndValidate("<user>", "{}", THEMES, DEFAULT_DSL_CONFIG);
    const gate = stateGate(config);
    const domains = configOptionDomains(config);
    const written = Object.values(config.actions).flatMap((a) => {
      if (!("set" in a)) return [];
      const values =
        "to" in a
          ? [a.to]
          : "from" in a
            ? resolveOptionDomain(a.from, domains).members
            : "cycle" in a
              ? a.cycle
              : "int" in a
                ? ["-1", "0", "3"]
                : [String(a.min), String(a.max)];
      return values.map((value) => [a.set, value] as const);
    });
    expect(written.length).toBeGreaterThan(100);
    const foreign = written.flatMap(([key, value]) => {
      const result = gate.validate(key, value);
      return result.ok && gate.verdict(key, result.value).kind === "held"
        ? []
        : [[key, value]];
    });
    expect(foreign).toEqual([]);
    // A doctor run writes free text to its report keys, which no control
    // writes: the daemon's own state, never a domain warning.
    const reports = CHECKS.flatMap((c) =>
      Object.values(doctorReportKeys(c.name)),
    );
    expect(reports.length).toBeGreaterThan(0);
    for (const key of reports) {
      expect(gate.verdict(key, "the probe said: no tty")).toEqual({
        kind: "held",
      });
    }
  });
});

describe("a domain warning", () => {
  test("names the key, the value held and what the key admits, and is about its key alone", () => {
    const warning = domainWarning({
      key: "style",
      held: "no-such-style",
      admits: 'one of "none", "flat"',
    });
    expect(warning.message).toBe(
      `"style" holds "no-such-style", which this config does not admit (it admits one of "none", "flat"), so the bar draws its default instead`,
    );
    // Its identity is the key's: a viewer open on it stays on it while the
    // words change, and clearing another key never moves it.
    expect(standingAbout(warning)).toBe("domain\0style");
    expect(
      standingAbout(domainWarning({ key: "style", held: "x", admits: "y" })),
    ).toBe(standingAbout(warning));
    expect(
      standingAbout(domainWarning({ key: "theme", held: "x", admits: "y" })),
    ).not.toBe(standingAbout(warning));
  });
});
