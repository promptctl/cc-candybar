// The host performs a config write the renderer returned: it splices the
// changes into the session's user layer, refuses the whole change when a
// setting it read has moved, and the renderer hears how it landed before the
// turn that returned it is answered.

import fs from "node:fs";
import path from "node:path";
import { diffChanges } from "../src/config/config-changes";
import { configInterpreter } from "../src/daemon/effect-interpreter";
import { rendererHost } from "../src/daemon/renderer-host";
import type { SessionId } from "../src/daemon/foundations/session-id";
import type {
  ConfigChange,
  EffectId,
  EventInput,
} from "../src/renderer-interface/interface";
import { systemTimekeeper } from "../src/time";
import { instantAt } from "../src/utils/instant";
import { jestTmpDir } from "./helpers/jest-tmp";
import { eventRenderer } from "./helpers/renderers";

const SESSION = "s-1" as SessionId;
const BEFORE = `{\n  // mine\n  globals: { theme: 'mocha', padding: 2 },\n}\n`;
const AFTER = `{\n  // mine\n  globals: { theme: 'nord', padding: 2 },\n}\n`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = jestTmpDir("config");
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, "config.json5");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const change = (
  before: string | null,
  after: string | null,
  id = 7,
): ConfigChange => ({
  kind: "change",
  id: id as EffectId,
  session: SESSION,
  target: { kind: "layer", role: "user" },
  changes: diffChanges(before, after),
});

const interpreter = (layer: string | null = file) => {
  const logged: string[] = [];
  return {
    logged,
    interpreter: configInterpreter({
      userLayer: (session) => (session === SESSION ? layer : null),
      log: (level, line) => void logged.push(`${level} ${line}`),
    }),
  };
};

describe("the config interpreter", () => {
  test("splices the changes into the session's user layer, keeping every other byte", () => {
    fs.writeFileSync(file, BEFORE);
    expect(interpreter().interpreter.change(change(BEFORE, AFTER))).toEqual({
      kind: "ok",
    });
    expect(fs.readFileSync(file, "utf8")).toBe(AFTER);
  });

  test("creates the file a first write names, and removes it again", () => {
    const { interpreter: host } = interpreter();
    expect(host.change(change(null, AFTER))).toEqual({ kind: "ok" });
    expect(fs.readFileSync(file, "utf8")).toBe(AFTER);
    expect(host.change(change(AFTER, null))).toEqual({ kind: "ok" });
    expect(fs.existsSync(file)).toBe(false);
  });

  test("refuses the whole change, naming the setting, when a hand edit moved what it read", () => {
    const edited = BEFORE.replace("mocha", "latte");
    fs.writeFileSync(file, edited);
    const { interpreter: host, logged } = interpreter();
    const outcome = host.change(change(BEFORE, AFTER));
    expect(outcome).toEqual({
      kind: "refused",
      reason: expect.stringContaining(
        'globals.theme changed since it was read: it was "mocha", and is now "latte"',
      ),
    });
    expect(fs.readFileSync(file, "utf8")).toBe(edited);
    expect(logged).toEqual([
      expect.stringMatching(/^warn config: change refused/),
    ]);
  });

  test("fails a change for a session the host holds no request of, writing nothing", () => {
    expect(interpreter(null).interpreter.change(change(null, AFTER))).toEqual({
      kind: "failed",
      reason: expect.stringContaining(`holds no request of session ${SESSION}`),
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  test("fails a write the filesystem refuses, said on the log", () => {
    const blocked = path.join(dir, "not-a-dir");
    fs.writeFileSync(blocked, "");
    const { interpreter: host, logged } = interpreter(
      path.join(blocked, "config.json5"),
    );
    expect(host.change(change(null, AFTER))).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("config write failed"),
    });
    expect(logged).toEqual([
      expect.stringMatching(/^error config write failed/),
    ]);
  });
});

describe("a host whose renderer returns a change", () => {
  test("performs it, and the renderer hears how it landed before the turn is answered", async () => {
    fs.writeFileSync(file, BEFORE);
    const heard: string[] = [];
    const host = rendererHost(
      "main",
      systemTimekeeper,
      eventRenderer(async (input: EventInput) => {
        heard.push(
          input.event.kind === "effect-done"
            ? `effect-done ${input.event.of} ${input.event.outcome.kind}`
            : input.event.kind,
        );
        return {
          kind: "answered",
          effects:
            input.event.kind === "menu-idle" ? [change(BEFORE, AFTER)] : [],
          record: [],
          subscriptions: { sources: {} },
          turnMs: 0,
        };
      }),
      () => {},
      { subscribed: () => {}, holding: () => () => {} },
      interpreter().interpreter,
    );
    await host.deliver(
      {
        kind: "event",
        at: instantAt(systemTimekeeper),
        event: {
          kind: "menu-idle",
          session: SESSION,
          idle: { firedAt: instantAt(systemTimekeeper), idleS: 1, timeoutS: 1 },
          latest: null,
        },
      },
      [],
    );
    expect(heard).toEqual(["menu-idle", "effect-done 7 ok"]);
    expect(fs.readFileSync(file, "utf8")).toBe(AFTER);
  });
});
