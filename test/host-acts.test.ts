// [LAW:verifiable-goals] A turn's acts as the host takes them
// (src/daemon/renderer-host.ts): performed only once the turn's config
// changes have landed, in the order the turn returned them, and never once
// the daemon's close has begun; the acts over in the turn are settled before
// the turn's caller hears it, and an act's failure no session's bar can hold
// is the daemon's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rendererHost, type HostWorld } from "../src/daemon/renderer-host";
import type { HostAct } from "../src/daemon/acts";
import { RendererDown } from "../src/daemon/foundations/verb-error";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { diffChanges } from "../src/config/config-changes";
import type {
  Act,
  Effect,
  EffectId,
  EffectOutcome,
  EventInput,
  RendererOutput,
} from "../src/renderer-interface/interface";
import type { Monotonic } from "../src/time";
import { eventRenderer, hostHeld } from "./helpers/renderers";
import { NO_CONFIGS } from "./helpers/renderers";

const S = sessionIdOf("s");
// No wake is declared, so no timer is set.
const CLOCK = {
  now: () => 0,
  monotonic: () => 0 as Monotonic,
  after: (): (() => void) => {
    throw new Error("this rig sets no timer");
  },
};
const FILE = `{ globals: { theme: "dusk" } }\n`;

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-host-acts-"));
  file = path.join(dir, "config.json5");
  fs.writeFileSync(file, FILE);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const output = (effects: readonly Effect[]): RendererOutput => ({
  kind: "answered",
  effects,
  subscriptions: { sources: {}, lanes: {}, configs: [], wake: null },
  record: [],
  frames: [],
});

let ids = 0;
const copy = (session = S as typeof S | null): Act => ({
  kind: "copy",
  id: ++ids as EffectId,
  session,
  text: "x",
});
const run = (): Act => ({
  kind: "run",
  id: ++ids as EffectId,
  session: S,
  action: "a",
  program: "/bin/true",
  args: [],
  env: {},
  cwd: "/",
  refreshes: [],
});
const change = (before: string, after: string): Effect => ({
  kind: "change",
  id: ++ids as EffectId,
  session: S,
  target: {
    kind: "layer",
    origin: { projectDir: dir, cwd: dir, target: { source: "search" } },
    role: "user",
  },
  changes: diffChanges(before, after),
});

// A host over a renderer whose one turn returns `effects`, and which hears
// each `effect-done` as `done` answers it. Every act is performed by
// `perform`, and what happened is in `did`, in order.
function hostOver(
  effects: readonly Effect[],
  over: Partial<HostWorld> = {},
  done: (input: EventInput) => Promise<RendererOutput> = async () => output([]),
) {
  const did: string[] = [];
  const unheard: string[] = [];
  const world: HostWorld = {
    perform: async (act: HostAct): Promise<EffectOutcome> => {
      did.push(
        `perform ${act.kind} ${act.id} (file says ${fs.readFileSync(file, "utf8").includes("dawn") ? "dawn" : "dusk"})`,
      );
      return { kind: "ok" };
    },
    stateDir: path.join(dir, "state"),
    // The origin's one layer is the test's file.
    configs: { ...NO_CONFIGS, path: () => file, repoDir: () => null },
    closing: () => false,
    unheard: (text) => void unheard.push(text),
    ...over,
  };
  const host = rendererHost(
    "main",
    CLOCK,
    hostHeld(
      eventRenderer(async (input) => {
        if (input.event.kind === "effect-done") {
          did.push(`done ${input.event.of} ${input.event.outcome.kind}`);
          return done(input);
        }
        return output(effects);
      }),
    ),
    () => {},
    {
      subscribed: () => {},
      frames: () => {},
      holding: () => () => {},
      writableSettings: () => [],
    },
    world,
  );
  const turn = () =>
    host.answer(() => ({ kind: "event", event: { kind: "due" } }));
  return { turn, did, unheard };
}

test("an act is performed once the turn's changes have landed and had their effect-done, wherever the turn returned it, and both are settled before the turn's caller hears it", async () => {
  const set = change(FILE, FILE.replace("dusk", "dawn"));
  const act = copy();
  // The change's effect-done turn takes a few microtasks to answer.
  const { turn, did } = hostOver([act, set], {}, async (input) => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    did.push(`answered ${input.event.kind}`);
    return output([]);
  });
  const answered = await turn();
  // The act saw the file the change wrote, and began only once the renderer
  // had answered the change's landing.
  expect(did).toEqual([
    `done ${set.id} ok`,
    "answered effect-done",
    `perform copy ${act.id} (file says dawn)`,
    `done ${act.id} ok`,
    "answered effect-done",
  ]);
  expect(answered.settled).toEqual([{ kind: "ok" }, { kind: "ok" }]);
});

test("a landing that failed performs no act: each is skipped, and only the changes say why", async () => {
  // The file moved since the change read it.
  fs.writeFileSync(file, FILE.replace("dusk", "noon"));
  const set = change(FILE, FILE.replace("dusk", "dawn"));
  const [act, sessionless] = [copy(), copy(null)];
  const { turn, did, unheard } = hostOver([set, act, sessionless]);
  const answered = await turn();
  expect(did).toEqual([
    `done ${set.id} refused`,
    `done ${act.id} skipped`,
    `done ${sessionless.id} skipped`,
  ]);
  expect(answered.settled.map((o) => o.kind)).toEqual([
    "refused",
    "skipped",
    "skipped",
  ]);
  // A skipped act with no session is no failure of the daemon's.
  expect(unheard).toEqual([]);
});

test("once the daemon's close has begun, nothing lands and no act is performed", async () => {
  const set = change(FILE, FILE.replace("dusk", "dawn"));
  const act = copy();
  const { turn, did } = hostOver([set, act], { closing: () => true });
  await turn();
  expect(fs.readFileSync(file, "utf8")).toBe(FILE);
  expect(did).toEqual([`done ${set.id} closing`, `done ${act.id} closing`]);
});

// A turn of acts alone has nothing to land: the close still stops them, and
// says so, so the click is answered closing, never ok.
test("once the daemon's close has begun, a turn of acts alone settles each closing", async () => {
  const act = copy();
  const { turn, did } = hostOver([act], { closing: () => true });
  const answered = await turn();
  expect(did).toEqual([`done ${act.id} closing`]);
  expect(answered.settled.map((o) => o.kind)).toEqual(["closing"]);
});

// Two copies: the clipboard ends with the one the turn asked last.
test("each act over in its turn starts once the one before it has ended", async () => {
  const [a, b] = [copy(), copy()];
  const ends: Array<() => void> = [];
  const { turn, did } = hostOver([a, b], {
    perform: (act) => {
      did.push(`start ${act.id}`);
      return new Promise((r) =>
        ends.push(() => {
          did.push(`end ${act.id}`);
          r({ kind: "ok" });
        }),
      );
    },
  });
  const answered = turn();
  await new Promise((r) => setImmediate(r));
  expect(did).toEqual([`start ${a.id}`]);
  ends[0]!();
  await new Promise((r) => setImmediate(r));
  expect(did.filter((d) => !d.startsWith("done"))).toEqual([
    `start ${a.id}`,
    `end ${a.id}`,
    `start ${b.id}`,
  ]);
  ends[1]!();
  await answered;
});

test("the acts of one turn are performed in the order the turn returned them", async () => {
  const [a, b] = [copy(), copy()];
  const { turn, did } = hostOver([a, b]);
  await turn();
  expect(did.filter((d) => d.startsWith("perform"))).toEqual([
    `perform copy ${a.id} (file says dusk)`,
    `perform copy ${b.id} (file says dusk)`,
  ]);
});

test("an act that outlives its turn is not waited for: it is settled when it ends", async () => {
  let end!: (outcome: EffectOutcome) => void;
  const lasting = run();
  const { turn, did } = hostOver([lasting], {
    perform: () => new Promise((r) => (end = r)),
  });
  const answered = await turn();
  expect(answered.settled).toEqual([]);
  expect(did).toEqual([]);
  end({ kind: "failed", reason: "run a: exited with code 1" });
  await new Promise((r) => setImmediate(r));
  expect(did).toEqual([`done ${lasting.id} failed`]);
});

test("an act with no session that failed is the daemon's to show", async () => {
  const { turn, unheard } = hostOver([copy(null)], {
    perform: async () => ({ kind: "failed", reason: "copy: pbcopy failed" }),
  });
  await turn();
  expect(unheard).toEqual(["copy: pbcopy failed"]);
});

test("a session's failed act whose renderer has ended is the daemon's to show", async () => {
  const { turn, unheard } = hostOver(
    [copy()],
    { perform: async () => ({ kind: "refused", reason: "copy: no" }) },
    async () => {
      throw new RendererDown("the renderer ended");
    },
  );
  await turn();
  expect(unheard).toEqual(["copy: no"]);
});

test("a session's failed act its renderer heard is its renderer's to show", async () => {
  const { turn, unheard } = hostOver([copy()], {
    perform: async () => ({ kind: "failed", reason: "copy: pbcopy failed" }),
  });
  await turn();
  expect(unheard).toEqual([]);
});
