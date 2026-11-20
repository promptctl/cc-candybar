// [LAW:verifiable-goals] An origin's config as the host routes it
// (src/daemon/renderer-host.ts): an origin a turn newly names gets its
// `config` turn in that turn's slot, before anything queued behind it; each
// origin a turn's landing moved gets its own there too, before the landing's
// `effect-done`; and an origin a watch moved that the renderer let go before
// its slot came is abandoned, with nothing handed in.

import fs from "node:fs";
import {
  MAIN_RENDERER,
  rendererNameOf,
  type RendererName,
} from "../src/daemon/foundations/renderer-name";
import os from "node:os";
import path from "node:path";
import type { RenderOrigin } from "../src/config-hint";
import type { ConfigSnapshot } from "../src/config/config-snapshot";
import { diffChanges } from "../src/config/config-changes";
import {
  rendererHost,
  type HostWorld,
  type RendererHost,
} from "../src/daemon/renderer-host";
import { ConfigDiscovery } from "../src/daemon/config-discovery/config-discovery";
import {
  writeConfigFile,
  type WriteConfigFile,
} from "../src/daemon/file-rewrites";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { locations } from "../src/daemon/paths";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type {
  Effect,
  EffectId,
  Event,
  EventInput,
  RendererOutput,
} from "../src/renderer-interface/interface";
import { systemTimekeeper, type Monotonic } from "../src/time";
import { readTextIfPresent } from "../src/utils/regular-text";
import { eventRenderer, hostHeld, NO_ACTS } from "./helpers/renderers";
import { originOf } from "./helpers/config-host";
import { HOST } from "./helpers/host";

const S = sessionIdOf("s");
const CLOCK = {
  now: () => 0,
  monotonic: () => 0 as Monotonic,
  after: (): (() => void) => {
    throw new Error("this rig sets no timer");
  },
  detach: systemTimekeeper.detach,
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
  stored: [],
  effects,
  subscriptions: { sources: {}, lanes: {}, managedFolders: [], configSelections: [], configs },
  wake: null,
  record: [],
  frames: [],
});

// A host over a renderer whose every turn answers `turn` of its event, and
// whose discovery follows what each output names, holds `SNAPSHOT` for each
// followed origin, and answers `landed` for a landing. `heard` is every
// event the renderer heard, in order, and `logged` every line.
function hostOver(
  turn: (event: Event) => RendererOutput,
  landed: HostWorld["configs"]["landed"] = () => [],
  bound?: {
    readonly name: RendererName;
    readonly configs: HostWorld["configs"];
    readonly writeConfigFile?: WriteConfigFile;
  },
) {
  const heard: string[] = [];
  const logged: string[] = [];
  const follows: Array<readonly RenderOrigin[]> = [];
  const declarations: RendererOutput["subscriptions"][] = [];
  let followed: readonly RenderOrigin[] = [];
  const configs: HostWorld["configs"] = {
    ...NO_ACTS.configs,
    follow: (origins) => {
      follows.push(origins);
      followed = origins;
    },
    snapshotOf: (origin) =>
      followed.some((o) => o.projectDir === origin.projectDir)
        ? SNAPSHOT
        : null,
    landed,
    // Every origin's one layer is the test's file: a landing's origin is
    // one an earlier output named.
    path: (_origin, role) => (role === "user" ? file : null),
    repoDir: () => null,
    readText: readTextIfPresent,
  };
  const host = rendererHost(
    bound?.name ?? MAIN_RENDERER,
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
      subscribed: (value) => void declarations.push(value),
      frames: () => {},
      holding: () => () => {},
      stored: () => {},
      recorded: () => {},
    },
    {
      ...NO_ACTS,
      stateDir: path.join(dir, "state"),
      configs: bound?.configs ?? configs,
      writeConfigFile: bound?.writeConfigFile,
      unheard: (text) => void logged.push(`unheard ${text}`),
    },
  );
  return { host, heard, logged, follows, declarations };
}

const due = { kind: "due" } as const;

test("an origin a turn newly names gets its config turn in that turn's slot, ahead of the input behind it, and only once", async () => {
  const { host, heard } = hostOver(() => output([], [ORIGIN]));
  const first = host.answer(() => ({ kind: "event", event: due }));
  const second = host.answer(() => ({ kind: "event", event: due }));
  await Promise.all([first, second]);
  expect(heard).toEqual(["due", "config", "due"]);
});

test("the host takes a declaration once, drops its origins on replacement, and takes the same first plan after restart", async () => {
  const opened = output([], [ORIGIN]);
  const empty = output([], []);
  let current = opened;
  const { host, heard, follows, declarations } = hostOver(() => current);
  const dueTurn = () => host.answer(() => ({ kind: "event", event: due }));
  await dueTurn();
  await dueTurn();
  expect(heard).toEqual(["due", "config", "due"]);
  expect(follows).toEqual([[ORIGIN]]);
  expect(declarations).toEqual([opened.subscriptions]);
  current = empty;
  await dueTurn();
  expect(follows).toEqual([[ORIGIN], []]);
  expect(declarations).toEqual([opened.subscriptions, empty.subscriptions]);
  await dueTurn();
  await host.answer(() => ({
    kind: "event",
    event: { kind: "start", viewers: {}, sessions: [] },
  }));
  expect(follows).toEqual([[ORIGIN], []]);
  expect(declarations).toEqual([
    opened.subscriptions,
    empty.subscriptions,
    empty.subscriptions,
  ]);
});

function themeChange(origin = ORIGIN): Extract<Effect, { kind: "change" }> {
  const id = 1 as EffectId;
  return {
    kind: "change",
    id,
    session: S,
    target: { kind: "layer", origin, role: "user" },
    changes: diffChanges(
      `{ globals: { theme: "dusk" } }\n`,
      `{ globals: { theme: "dawn" } }\n`,
    ),
  };
}

test("each origin a turn's landing moved gets its config turn before the landing's effect-done", async () => {
  const change = themeChange();
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

test.each(["unreadable", "restored", "unrestored"] as const)(
  "only unrestored paths go to discovery before failed effects (%s)",
  async (restore) => {
    const destinations = {
      user: file,
      project: path.join(dir, "project.json5"),
      local: path.join(dir, "local.json5"),
    };
    const prior = fs.readFileSync(file, "utf8");
    fs.writeFileSync(destinations.project, prior);
    fs.writeFileSync(destinations.local, prior);
    const roles = ["user", "project", "local"] as const;
    const changes = roles.map((role, i) => {
      const change = themeChange();
      return {
        ...change,
        id: (i + 1) as EffectId,
        target: { ...change.target, role },
      };
    });
    const attempts: string[] = [];
    const observed: Array<readonly string[]> = [];
    const { host, heard } = hostOver(
      (event) => output(event.kind === "due" ? changes : [], [ORIGIN]),
      undefined,
      {
        name: MAIN_RENDERER,
        configs: {
          ...NO_ACTS.configs,
          follow: () => {},
          snapshotOf: () => SNAPSHOT,
          path: (_origin, role) => destinations[role],
          readText: (at) => {
            if (restore === "unreadable" && at === destinations.local)
              throw new Error("could not read local");
            return readTextIfPresent(at);
          },
          landed: (paths) => {
            observed.push(paths);
            return [ORIGIN];
          },
        },
        writeConfigFile: (at, text) => {
          attempts.push(at);
          if (at === destinations.local)
            throw new Error("could not publish local");
          if (
            restore === "unrestored" &&
            at === destinations.project &&
            text === prior
          )
            throw new Error("could not put project bytes back");
          writeConfigFile(at, text);
        },
      },
    );

    const answer = await host.answer(() => ({ kind: "event", event: due }));
    expect(attempts).toEqual(
      restore === "unreadable"
        ? []
        : [
            file,
            destinations.project,
            destinations.local,
            destinations.project,
            file,
          ],
    );
    expect(fs.readFileSync(file, "utf8")).toBe(prior);
    expect(observed).toEqual(
      restore === "unrestored" ? [[destinations.project]] : [],
    );
    expect(heard).toEqual([
      "due",
      "config",
      ...(restore === "unrestored" ? ["config"] : []),
      "effect-done failed",
      "effect-done failed",
      "effect-done failed",
    ]);
    expect(answer.settled).toEqual(
      roles.map(() => ({
        kind: "failed",
        reason: expect.stringContaining(
          restore === "unreadable"
            ? "config read failed"
            : "could not publish local",
        ),
      })),
    );
  },
);

test("failed rediscovery reports its own failure after the successful write", async () => {
  const change = themeChange();
  const { host, heard, logged } = hostOver(
    (event) => output(event.kind === "due" ? [change] : [], [ORIGIN]),
    () => {
      throw new Error("rediscovery refused");
    },
  );

  const answered = await host.answer(() => ({ kind: "event", event: due }));
  expect(answered.kind).toBe("answered");
  expect(answered.settled).toEqual([{ kind: "ok" }]);
  expect(heard).toEqual(["due", "config", "effect-done ok"]);
  expect(fs.readFileSync(file, "utf8")).toContain("dawn");
  expect(logged).toContainEqual(expect.stringContaining("rediscovery refused"));
});

test("a write through a config symlink reloads the remaining holder after the writer releases", async () => {
  const link = path.join(dir, "linked.json5");
  fs.symlinkSync(file, link);
  const origin = originOf(dir, dir, link);
  const secondary = rendererNameOf("secondary");
  const watches = new WatcherRegistry({ clock: systemTimekeeper });
  const hosts = new Map<RendererName, RendererHost>();
  const discovery = new ConfigDiscovery({
    clock: systemTimekeeper,
    locations: locations(HOST),
    stateDir: path.join(dir, "state"),
    watchers: watches,
    log: () => {},
    moved: (name, origins) => hosts.get(name)?.moved(origins),
  });
  try {
    const change = themeChange(origin);
    let writing = false;
    const main = hostOver(
      (event) =>
        writing
          ? output(event.kind === "due" ? [change] : [], [])
          : output([], [origin]),
      undefined,
      { name: MAIN_RENDERER, configs: discovery.forRenderer(MAIN_RENDERER) },
    );
    const other = hostOver(() => output([], [origin]), undefined, {
      name: secondary,
      configs: discovery.forRenderer(secondary),
    });
    hosts.set(main.host.name, main.host);
    hosts.set(other.host.name, other.host);
    const tick = () => ({ kind: "event", event: due }) as const;
    await main.host.answer(tick);
    await other.host.answer(tick);
    writing = true;
    const answered = await main.host.answer(tick);
    // A due behind the secondary's queued reload proves it already ran.
    await other.host.answer(tick);
    expect(answered.settled).toEqual([{ kind: "ok" }]);
    expect(fs.readFileSync(file, "utf8")).toContain("dawn");
    expect(main.heard).toEqual(["due", "config", "due", "effect-done ok"]);
    expect(other.heard).toEqual(["due", "config", "config", "due"]);
  } finally {
    discovery.close();
    watches.closeAll();
  }
});

// [LAW:one-source-of-truth] The accepted origin survives a failed replacement.
// Its next successful replacement receives the held observation in START.
test("an unanswered start keeps the previous declaration until the next successful start", async () => {
  const opened = output([], [ORIGIN]);
  let fail = true;
  const { host, heard, declarations } = hostOver((event) => {
    if (event.kind === "start") {
      expect(event.configs).toEqual([{ origin: ORIGIN, config: SNAPSHOT }]);
      if (fail) throw new Error("the renderer went down");
    }
    return opened;
  });
  await host.answer(() => ({ kind: "event", event: due }));
  const start = () => host.answer(() => ({
    kind: "event",
    event: { kind: "start", viewers: {}, sessions: [] },
  }));
  const refused = {
    kind: "threw",
    failure: { message: "the renderer went down" },
  };
  expect(await start()).toMatchObject(refused);
  expect(await host.answer(() => ({ kind: "event", event: due }))).toMatchObject(refused);
  expect(heard).toEqual(["due", "config", "start"]);
  expect(declarations).toEqual([opened.subscriptions]);
  fail = false;
  expect(await start()).toMatchObject({ kind: "answered" });
  await host.answer(() => ({ kind: "event", event: due }));
  expect(heard).toEqual(["due", "config", "start", "start", "due"]);
  expect(declarations).toEqual([opened.subscriptions, opened.subscriptions]);
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
            stored: [],
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
            stored: [],
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
