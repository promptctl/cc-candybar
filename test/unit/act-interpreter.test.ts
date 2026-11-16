// The host's acts (src/daemon/act-interpreter.ts, src/daemon/renderer-host.ts):
// each act a turn returns is performed by its own kind's performer, the turn's
// caller waits for the acts that end in its turn and for no other, and an act
// that failed where no bar can show it reaches every bar.

import {
  actInterpreter,
  type ActPerformers,
} from "../../src/daemon/act-interpreter";
import { rendererHost } from "../../src/daemon/renderer-host";
import type {
  Act,
  Effect,
  EffectId,
  EffectOutcome,
  RendererOutput,
} from "../../src/renderer-interface/interface";
import { failureOf } from "../../src/daemon/foundations/verb-error";
import { eventRenderer } from "../helpers/renderers";
import { instantOf } from "../../src/utils/instant";
import { fieldOf } from "../../src/utils/logfmt";
import type { Monotonic } from "../../src/time";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";

const SID = sessionIdOf("s1");
const CLOCK = { now: () => 0, monotonic: () => 0 as Monotonic };

const ok = async (): Promise<EffectOutcome> => ({ kind: "ok" });
const failed = (reason: string) => async (): Promise<EffectOutcome> => ({
  kind: "failed",
  reason,
});

// Every kind performed at once, ok; a test hands in the ones it reads.
const performers = (over: Partial<ActPerformers> = {}): ActPerformers => ({
  copy: { endsInTurn: true, perform: ok },
  open: { endsInTurn: true, perform: ok },
  "type-slash": { endsInTurn: true, perform: ok },
  run: { endsInTurn: false, perform: ok },
  "approve-repo": { endsInTurn: true, perform: ok },
  "apply-update": { endsInTurn: true, perform: ok },
  "restart-claude": { endsInTurn: false, perform: ok },
  surface: { endsInTurn: false, perform: ok },
  ...over,
});

const copy = (id: number, session = SID as typeof SID | null): Act => ({
  kind: "copy",
  id: id as EffectId,
  session,
  text: "x",
});

const run = (id: number): Act => ({
  kind: "run",
  id: id as EffectId,
  session: SID,
  program: { action: "go", argv: ["true"], env: {}, cwd: "/", refreshes: [] },
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function drain(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

describe("the act interpreter", () => {
  test("each act goes to its own kind's performer, which says whether its turn waits", async () => {
    const performed: string[] = [];
    const acts = actInterpreter(
      performers({
        copy: {
          endsInTurn: true,
          perform: async (a) => (
            performed.push(`copy ${a.text}`),
            { kind: "ok" }
          ),
        },
        run: {
          endsInTurn: false,
          perform: async (a) => (
            performed.push(`run ${a.program.action}`),
            { kind: "ok" }
          ),
        },
      }),
      CLOCK,
      () => {},
    );
    expect(await acts.perform(copy(1))).toEqual({ kind: "ok" });
    expect(await acts.perform(run(2))).toEqual({ kind: "ok" });
    expect(performed).toEqual(["copy x", "run go"]);
    expect([acts.endsInTurn(copy(1)), acts.endsInTurn(run(2))]).toEqual([
      true,
      false,
    ]);
  });

  test("a performer that throws fails its act with what it said, and its line says so", async () => {
    const lines: string[] = [];
    const acts = actInterpreter(
      performers({
        copy: {
          endsInTurn: true,
          perform: async () => {
            throw new Error("pbcopy is gone");
          },
        },
      }),
      CLOCK,
      (level, line) => lines.push(`${level} ${line}`),
    );
    expect(await acts.perform(copy(7))).toEqual({
      kind: "failed",
      reason: "pbcopy is gone",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^warn effect /);
    expect(
      ["kind", "sid", "id", "outcome", "reason"].map((k) =>
        fieldOf(lines[0]!, k),
      ),
    ).toEqual(["copy", SID, "7", "failed", "pbcopy is gone"]);
  });
});

describe("the host's acts", () => {
  // A host over a renderer whose turn on `retire` returns `effects`, and which
  // hears each `effect-done` as `done <id> <outcome>`.
  function hostOver(
    effects: readonly Effect[],
    over: Partial<ActPerformers>,
    effectDone: (id: EffectId) => "answered" | "threw" = () => "answered",
  ) {
    const heard: string[] = [];
    const unseen: string[] = [];
    const out = (
      kind: "answered" | "threw",
      returned: readonly Effect[] = [],
    ): RendererOutput =>
      kind === "answered"
        ? {
            kind,
            record: [],
            effects: returned,
            subscriptions: { sources: {} },
            turnMs: 0,
          }
        : {
            kind,
            failure: failureOf(new Error("the renderer broke")),
            record: [],
            effects: [],
            subscriptions: { sources: {} },
            turnMs: 0,
          };
    const host = rendererHost(
      "main",
      CLOCK,
      eventRenderer(async ({ event }) => {
        if (event.kind !== "effect-done") return out("answered", effects);
        heard.push(`done ${event.of} ${event.outcome.kind}`);
        return out(effectDone(event.of));
      }),
      () => {},
      { subscribed: () => {}, holding: () => () => {} },
      {
        interpreter: actInterpreter(performers(over), CLOCK, () => {}),
        unseen: (text) => unseen.push(text),
      },
    );
    const turn = () =>
      host.answer({
        kind: "event",
        at: instantOf(new Date(0)),
        event: { kind: "retire", session: SID },
      });
    return { turn, heard, unseen };
  }

  test("a turn's caller waits for the acts that end in its turn, and not for one that outlives it", async () => {
    const copied = gate();
    const ran = gate();
    const { turn, heard } = hostOver([copy(1), run(2)], {
      copy: { endsInTurn: true, perform: () => copied.wait.then(ok) },
      run: { endsInTurn: false, perform: () => ran.wait.then(ok) },
    });
    let answered = false;
    const answering = turn().then(() => (answered = true));
    await drain();
    expect(answered).toBe(false);
    copied.open();
    await answering;
    expect(heard).toEqual(["done 1 ok"]);
    ran.open();
    await drain();
    expect(heard).toEqual(["done 1 ok", "done 2 ok"]);
  });

  test("a failed act with a session is its bar's; one whose click named none reaches every bar", async () => {
    const { turn, heard, unseen } = hostOver([copy(1), copy(2, null)], {
      copy: { endsInTurn: true, perform: failed("pbcopy is gone") },
    });
    await turn();
    expect(heard).toEqual(["done 1 failed", "done 2 failed"]);
    expect(unseen).toEqual(["copy: pbcopy is gone"]);
  });

  test("the turn's caller hears how the acts it waited for ended: a failure over refusals, and nothing of an act that outlives it", async () => {
    const refusing = {
      endsInTurn: true,
      perform: async () => ({
        kind: "refused" as const,
        reason: "already rebuilding",
      }),
    };
    expect(
      (await hostOver([copy(1), copy(2)], { copy: refusing }).turn())
        .actsFailed,
    ).toMatchObject({
      kind: "bad-request",
      message: "copy: already rebuilding; copy: already rebuilding",
    });
    expect(
      (
        await hostOver([copy(1), run(2)], {
          copy: refusing,
          run: { endsInTurn: true, perform: failed("exited 3") },
        }).turn()
      ).actsFailed,
    ).toMatchObject({
      kind: "threw",
      message: "copy: already rebuilding; run: exited 3",
    });
    expect(
      (
        await hostOver([run(1)], {
          run: { endsInTurn: false, perform: failed("exited 3") },
        }).turn()
      ).actsFailed,
    ).toBeNull();
  });

  test("a failed act whose effect-done turn threw reaches every bar", async () => {
    const { turn, unseen } = hostOver(
      [copy(1)],
      { copy: { endsInTurn: true, perform: failed("pbcopy is gone") } },
      () => "threw",
    );
    await turn();
    expect(unseen).toEqual(["copy: pbcopy is gone"]);
  });
});
