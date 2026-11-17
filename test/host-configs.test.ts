// [LAW:verifiable-goals] An origin's config as the host routes it
// (src/daemon/renderer-host.ts): an origin a turn newly names gets its
// `config` turn in that turn's slot, before anything queued behind it; each
// origin a turn's landing moved gets its own there too, before the landing's
// `effect-done`; and an origin a watch moved that the renderer let go before
// its slot came is abandoned, with nothing handed in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RenderOrigin } from "../src/config-hint";
import type { ConfigSnapshot } from "../src/config/config-snapshot";
import { diffChanges } from "../src/config/config-changes";
import { rendererHost, type HostWorld } from "../src/daemon/renderer-host";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type {
  Effect,
  EffectId,
  Event,
  EventInput,
  RendererOutput,
} from "../src/renderer-interface/interface";
import type { Monotonic } from "../src/time";
import { eventRenderer, hostHeld, NO_ACTS } from "./helpers/renderers";

const S = sessionIdOf("s");
const CLOCK = {
  now: () => 0,
  monotonic: () => 0 as Monotonic,
  after: (): (() => void) => {
    throw new Error("this rig sets no timer");
  },
};
const ORIGIN: RenderOrigin = {
  projectDir: "/p",
  cwd: "/p",
  target: { source: "search" },
};
const SNAPSHOT: ConfigSnapshot = {
  chain: [],
  repo: null,
  plugins: [],
  strays: [],
  checkout: null,
  notices: [],
  watch: null,
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-host-configs-"));
  file = path.join(dir, "config.json5");
  fs.writeFileSync(file, `{ globals: { theme: "dusk" } }\n`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const output = (
  effects: readonly Effect[],
  configs: readonly RenderOrigin[],
): RendererOutput => ({
  kind: "answered",
  effects,
  subscriptions: { sources: {}, lanes: {}, configs, wake: null },
  record: [],
  frames: [],
});

// A host over a renderer whose every turn answers `turn` of its event, and
// whose discovery follows what each output names, holds `SNAPSHOT` for each
// followed origin, and answers `landed` for a landing. `heard` is every
// event the renderer heard, in order, and `logged` every line.
function hostOver(
  turn: (event: Event) => RendererOutput,
  landed: () => readonly RenderOrigin[] = () => [],
) {
  const heard: string[] = [];
  const logged: string[] = [];
  let followed: readonly RenderOrigin[] = [];
  const configs: HostWorld["configs"] = {
    follow: (origins) => {
      followed = origins;
      return [];
    },
    snapshotOf: (origin) =>
      followed.some((o) => o.projectDir === origin.projectDir)
        ? SNAPSHOT
        : null,
    landed: () => landed(),
  };
  const host = rendererHost(
    "main",
    CLOCK,
    hostHeld(
      eventRenderer(async ({ event }: EventInput) => {
        heard.push(
          event.kind === "effect-done"
            ? `effect-done ${event.outcome.kind}`
            : event.kind,
        );
        return turn(event);
      }),
    ),
    (level, line) => logged.push(`${level} ${line}`),
    {
      subscribed: () => {},
      frames: () => {},
      holding: () => () => {},
      writableSettings: () => [],
    },
    { ...NO_ACTS, stateDir: path.join(dir, "state"), configs },
  );
  return { host, heard, logged };
}

const due = { kind: "due" } as const;

test("an origin a turn newly names gets its config turn in that turn's slot, ahead of the input behind it, and only once", async () => {
  const { host, heard } = hostOver(() => output([], [ORIGIN]));
  const first = host.answer(() => ({ kind: "event", event: due }));
  const second = host.answer(() => ({ kind: "event", event: due }));
  await Promise.all([first, second]);
  expect(heard).toEqual(["due", "config", "due"]);
});

test("each origin a turn's landing moved gets its config turn before the landing's effect-done", async () => {
  const id = 1 as EffectId;
  const change: Effect = {
    kind: "change",
    id,
    session: S,
    target: { kind: "layer", path: file },
    changes: diffChanges(
      `{ globals: { theme: "dusk" } }\n`,
      `{ globals: { theme: "dawn" } }\n`,
    ),
  };
  let landedOn = "";
  const { host, heard } = hostOver(
    (event) => output(event.kind === "due" ? [change] : [], [ORIGIN]),
    () => {
      landedOn = fs.readFileSync(file, "utf8");
      return [ORIGIN];
    },
  );
  const answered = await host.answer(() => ({ kind: "event", event: due }));
  expect(heard).toEqual(["due", "config", "config", "effect-done ok"]);
  // Discovery heard of the landing once the change was on disk.
  expect(landedOn).toContain("dawn");
  expect(answered.settled).toEqual([{ kind: "ok" }]);
});

test("an origin a watch moved that the renderer let go by its slot is abandoned, and no config is handed in", async () => {
  const { host, heard, logged } = hostOver(() => output([], []));
  host.moved([ORIGIN]);
  await host.answer(() => ({ kind: "event", event: due }));
  expect(heard).toEqual(["due"]);
  expect(logged.some((l) => l.includes("is no longer followed"))).toBe(true);
});
