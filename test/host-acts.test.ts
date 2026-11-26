// [LAW:verifiable-goals] A turn's acts as the host takes them
// (src/daemon/renderer-host.ts): performed only once the turn's config
// changes have landed, in the order the turn returned them, and never once
// the daemon's close has begun; the acts over in the turn are settled before
// the turn's caller hears it, and an act's failure no session's bar can hold
// is the daemon's.

import fs from "node:fs";
import { MAIN_RENDERER } from "../src/daemon/foundations/renderer-name";
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
import { handClock } from "./helpers/hand-clock";
import { eventRenderer, hostHeld } from "./helpers/renderers";
import { NO_CONFIGS } from "./helpers/renderers";
import { authorizeRun } from "../src/daemon/foundations/run-authorization";
import { VERB_RUN, type RunEvidence } from "../src/click/wire";
import { TEST_SIGNER } from "./helpers/link-signer";
import { readTextIfPresent } from "../src/utils/regular-text";

const S = sessionIdOf("s");
// No wake is declared, so no timer is set.
const CLOCK = handClock({ now: () => 0, monotonic: () => 0 as Monotonic });
const FILE = `{ globals: { theme: "dusk" } }\n`;
const RUN_INPUT = JSON.stringify({ run: ["/bin/true"], env: {} });
const RUN_DECLARATION = "the run's declaration";

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
  stored: [],
  effects,
  subscriptions: { sources: {}, lanes: {}, managedFolders: [], configSelections: [], configs: [] },
  wake: null,
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
const run = (): Extract<Act, { kind: "run" }> => ({
  kind: "run",
  id: ++ids as EffectId,
  session: S,
  action: "a",
  declaration: RUN_DECLARATION,
  capture: 0,
  cwd: "/",
  refreshes: [],
});
const evidence = (): RunEvidence => ({
  session: S,
  action: "a",
  evaluated: RUN_INPUT,
  mac: TEST_SIGNER.sign({
    sessionId: S,
    action: "a",
    declaration: RUN_DECLARATION,
    evaluated: RUN_INPUT,
  }),
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
  const heard: EventInput[] = [];
  const world: HostWorld = {
    authorizeRun: (request, captures) => authorizeRun(TEST_SIGNER, request, captures),
    perform: async (act: HostAct): Promise<EffectOutcome> => {
      did.push(
        `perform ${act.kind} ${act.id} (file says ${fs.readFileSync(file, "utf8").includes("dawn") ? "dawn" : "dusk"})`,
      );
      return { kind: "ok" };
    },
    stateDir: path.join(dir, "state"),
    // The origin's one layer is the test's file.
    configs: {
      ...NO_CONFIGS,
      path: () => file,
      repoDir: () => null,
      readText: readTextIfPresent,
    },
    closing: () => false,
    acknowledgeDisplayed: () => {},
    reported: () => {},
    unheard: (text) => void unheard.push(text),
    ...over,
  };
  const host = rendererHost(
    MAIN_RENDERER,
    CLOCK,
    hostHeld(
      eventRenderer(async (input) => {
        heard.push(input);
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
      stored: () => {},
      recorded: () => {},
    },
    world,
  );
  const turn = (runEvidence?: readonly RunEvidence[], actsOn: "daemon" | "desktop" = "daemon") =>
    host.answer(() =>
      runEvidence === undefined
        ? { kind: "event", event: { kind: "due" } }
        : {
            kind: "event",
            runEvidence,
            actsOn,
            event: {
              kind: "click",
              click: {
                scope: "session",
                verb: VERB_RUN,
                session: S,
                steps: runEvidence.map(({ action }, capture) => ({
                  kind: "run",
                  verb: VERB_RUN,
                  action,
                  capture,
                })),
              },
              context: null,
            },
          },
    );
  return { turn, did, unheard, heard };
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
  const { turn, did, heard } = hostOver([lasting], {
    perform: () => new Promise((r) => (end = r)),
  });
  const captured = evidence();
  const answered = await turn([captured]);
  expect(heard[0]?.event).toMatchObject({
    kind: "click",
    click: { steps: [{ kind: "run", action: "a", capture: 0 }] },
  });
  const sent = JSON.stringify(heard[0]);
  expect(sent).not.toContain("evaluated");
  expect(sent).not.toContain(captured.mac);
  expect(answered.settled).toEqual([]);
  expect(did).toEqual([]);
  end({ kind: "failed", reason: "run a: exited with code 1" });
  await new Promise((r) => setImmediate(r));
  expect(did).toEqual([`done ${lasting.id} failed`]);
});

test("a denied run settles as a refusal before it can outlive the click", async () => {
  const denied = run();
  const [before, after] = [copy(), copy()];
  const { turn, did } = hostOver([before, denied, after]);
  const answered = await turn([{ ...evidence(), mac: "" }]);
  expect(answered.settled).toContainEqual({
    kind: "refused",
    reason: expect.stringContaining("signature does not match"),
  });
  expect(did).toContain(`done ${denied.id} refused`);
  expect(did.filter((line) => line.startsWith("perform"))).toEqual([
    `perform copy ${before.id} (file says dusk)`,
    `perform copy ${after.id} (file says dusk)`,
  ]);
});

test("a capture index has authority only within its click", async () => {
  const requested = run();
  const { turn, did } = hostOver([requested]);
  expect((await turn([evidence()])).settled).toEqual([]);
  const attempted = await turn();
  expect(attempted.settled).toEqual([
    { kind: "refused", reason: "run: the click did not capture this run" },
  ]);
  expect(did.filter((line) => line.startsWith("perform"))).toEqual([
    `perform run ${requested.id} (file says dusk)`,
  ]);
  expect(did).toContain(`done ${requested.id} refused`);
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

// [LAW:verifiable-goals] The click's connection decides where its acts go.
describe("a click forwarded from the desktop", () => {
  test("hands copies and remote files to its own writer in order", async () => {
    const copied = copy();
    const opened: Act = { kind: "open", id: ++ids as EffectId, session: S, target: file };
    const { turn, did } = hostOver([copied, opened]);
    const answered = await turn([], "desktop");
    expect(did).toEqual([`done ${copied.id} ok`, `done ${opened.id} ok`]);
    expect(answered.settled).toEqual([
      { kind: "desktop", act: { kind: "copy", text: "x" } },
      { kind: "desktop", act: { kind: "open", target: file, file: true } },
    ]);
  });

  test("closes without handing over an act after shutdown begins", async () => {
    const { turn } = hostOver([copy()], { closing: () => true });
    expect((await turn([], "desktop")).settled.map((o) => o.kind)).toEqual(["closing"]);
  });
});
