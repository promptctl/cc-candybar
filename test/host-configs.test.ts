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
  checkout: { root: "/p", git: false },
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
    },
    snapshotOf: (origin) =>
      followed.some((o) => o.projectDir === origin.projectDir)
        ? SNAPSHOT
        : null,
    landed: () => landed(),
    // Every origin's one layer is the test's file: a landing's origin is
    // one an earlier output named.
    path: (_origin, role) => (role === "user" ? file : null),
    repoDir: () => null,
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
    target: { kind: "layer", origin: ORIGIN, role: "user" },
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

// [LAW:one-source-of-truth] A renderer sent its start holds no config, so
// every origin it names after gets its config turn, though the start failed.
test("a start the renderer did not answer still leaves every origin it names after new", async () => {
  const { host, heard } = hostOver((event) => {
    if (event.kind === "start") throw new Error("the renderer went down");
    return output([], [ORIGIN]);
  });
  await host.answer(() => ({ kind: "event", event: due }));
  await host.answer(() => ({
    kind: "event",
    event: { kind: "start", viewers: {}, sessions: [] },
  }));
  await host.answer(() => ({ kind: "event", event: due }));
  expect(heard).toEqual(["due", "config", "start", "due", "config"]);
});

test("an origin a watch moved that the renderer let go by its slot is abandoned, and no config is handed in", async () => {
  const { host, heard, logged } = hostOver(() => output([], []));
  host.moved([ORIGIN]);
  await host.answer(() => ({ kind: "event", event: due }));
  expect(heard).toEqual(["due"]);
  expect(logged.some((l) => l.includes("is no longer followed"))).toBe(true);
});

// [LAW:no-silent-failure] A click that waited for its origin's config runs in
// that config turn, so the turn that named the origin answers for it.
describe("a turn settles as the config turns it named", () => {
  test("a change one of them returned is among its outcomes, refused as it landed", async () => {
    const change: Effect = {
      kind: "change",
      id: 1 as EffectId,
      session: S,
      target: { kind: "layer", origin: ORIGIN, role: "user" },
      // Read from a file the disk no longer holds.
      changes: diffChanges(
        `{ globals: { theme: "noon" } }\n`,
        `{ globals: { theme: "dawn" } }\n`,
      ),
    };
    const { host, heard } = hostOver((event) =>
      output(event.kind === "config" ? [change] : [], [ORIGIN]),
    );
    const answered = await host.answer(() => ({ kind: "event", event: due }));
    expect(heard).toEqual(["due", "config", "effect-done refused"]);
    expect(answered.settled).toEqual([
      { kind: "refused", reason: expect.any(String) },
    ]);
  });

  // Its landing's config turns run nothing of the turn's: what fails there
  // is that turn's own line, never the turn's answer.
  test("a config turn its landing moved is waited for, and its failure is not among its outcomes", async () => {
    const change: Effect = {
      kind: "change",
      id: 1 as EffectId,
      session: S,
      target: { kind: "layer", origin: ORIGIN, role: "user" },
      changes: diffChanges(
        `{ globals: { theme: "dusk" } }\n`,
        `{ globals: { theme: "dawn" } }\n`,
      ),
    };
    let configs = 0;
    const { host, heard, logged } = hostOver(
      (event) => {
        if (event.kind === "config" && ++configs === 2)
          return {
            ...output([], [ORIGIN]),
            kind: "threw",
            failure: {
              kind: "threw",
              message: "the reload broke",
              detail: "the reload broke",
            },
          };
        return output(event.kind === "due" ? [change] : [], [ORIGIN]);
      },
      () => [ORIGIN],
    );
    const answered = await host.answer(() => ({ kind: "event", event: due }));
    expect(heard).toEqual(["due", "config", "config", "effect-done ok"]);
    expect(answered.settled).toEqual([{ kind: "ok" }]);
    expect(logged.some((l) => l.includes("the reload broke"))).toBe(true);
  });

  test("one that threw is its failure", async () => {
    const { host } = hostOver((event) =>
      event.kind === "config"
        ? {
            ...output([], [ORIGIN]),
            kind: "threw",
            failure: {
              kind: "threw",
              message: "the waiting click broke",
              detail: "the waiting click broke",
            },
          }
        : output([], [ORIGIN]),
    );
    const answered = await host.answer(() => ({ kind: "event", event: due }));
    expect(answered.settled).toEqual([
      { kind: "failed", reason: "the waiting click broke" },
    ]);
  });

  // The first origin's config turn lets the second go before its slot.
  test("one whose origin was let go before its slot ran nothing, and is its failure", async () => {
    const other: RenderOrigin = { ...ORIGIN, projectDir: "/q", cwd: "/q" };
    const { host, heard } = hostOver((event) =>
      output([], event.kind === "config" ? [ORIGIN] : [ORIGIN, other]),
    );
    const answered = await host.answer(() => ({ kind: "event", event: due }));
    expect(heard).toEqual(["due", "config"]);
    expect(answered.settled).toEqual([
      { kind: "failed", reason: "the renderer let the origin go" },
    ]);
  });
});
