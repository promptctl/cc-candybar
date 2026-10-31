// [LAW:nothing-unseen] brandon-unfiled-3248.87p, measured on a daemon:
// every render request writes one render event — the `render …` log line —
// whatever its outcome. A render that draws the bar, one whose config fails
// partway (a broken gate), and one the daemon refuses each leave an event
// naming its outcome. The event's own fields, and the threw arm a renderer
// bug reaches, are held by test/request-event.test.ts.

import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { stripAnsi } from "./helpers/ansi";
import {
  encodeFrame,
  PROTOCOL_VERSION,
  TOTAL_BUDGET_MS,
} from "../src/daemon/protocol";
import { stateDir } from "../src/daemon/paths";
import { REQUEST_TIMEOUT_MS } from "../src/daemon/request-deadline";
import {
  hookData,
  killAndWait,
  render,
  renderBody,
  renderRequest,
  sendClick,
} from "./helpers/daemon-e2e";
import {
  effectsUrl,
  VERB_SET_STATE,
  VERB_TMUX_STATUS_CLICK,
} from "../src/click/wire";
import { CLICK_ERROR_HOLD_S } from "../src/daemon/click-error";
import { logLines, loggedLines, loggedWhen } from "./helpers/daemon-log";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { until } from "./helpers/until";
import {
  heldClock,
  startDaemon,
  type InWorkerDaemon,
} from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

const TEST_TIMEOUT_MS = 30_000;
import { DOOR_GLYPH } from "../src/config/disclosure";

jest.setTimeout(TEST_TIMEOUT_MS);

// `drawn` draws a bar. `broken` gates a row on a `when` that fails when it is
// evaluated, which costs that row and warns. `held` reads the tmux session name, which the
// payload awaits from a `tmux` spawn (src/segments/tmux.ts) — the stub below.
// `waiting` reads a document whose source never answers while the test runs.
// `ruled` chooses its style by a rule over the session, and its effect by one
// over the clock.
const CONFIGS = {
  drawn: `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  waiting: `{ variables: { doc: { kind: 'shell', command: 'sleep 60', parse: { json: true }, cache: { never: true } } }, segments: { mark: { template: '{{ .doc.x }}' } }, root: { h: ['mark'] } }`,
  broken: `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'], when: '{{ fail "the gate broke" }}' } }`,
  held: `{ segments: { mark: { template: '{{ .tmux.session }}' } }, root: { h: ['mark'] } }`,
  ruled: `{ globals: { style: '{{ if eq .session.id "x" }}vivid{{ else }}none{{ end }}', effect: '{{ if eq (mod (unixEpoch now) 2) 0 }}none{{ else }}none{{ end }}' }, segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
};

// [LAW:no-ambient-temporal-coupling] The `tmux` on the daemon's PATH: it
// connects to the gate beside it, a unix socket the test listens on, and
// answers only once the test writes a line into it. Its connection is its
// asking, so `asked` means "reading": the test opens the gate after the
// client has been answered, so the render provably outlives its deadline, an
// ordering the test owns, not a bet on how slow a render is. Only a render
// whose client reports a tmux pane runs it.
//
// The stub's life is the connection's. One the daemon launched dies with the
// daemon too, by the launcher's lifeline, but the test below starts one
// itself, which only its gate ends. Closing the gate, which afterAll does and
// the kernel does when the worker dies, ends the stub's read, and it exits 1; a
// stub started once the gate is closed finds nothing listening and exits at
// once. So a run that ends before its gate opens, however it ends, leaves no
// stub behind. The stub runs on the worker's own node, so it needs nothing
// from the daemon's PATH, and it says back through the gate that it heard.
const STUB_TMUX = [
  `#!${process.execPath}`,
  `const gate = require("node:net").connect(require("node:path").join(__dirname, "gate"));`,
  `process.exitCode = 1;`,
  `gate.once("data", () => { process.exitCode = 0; process.stdout.write("held\\n"); gate.end("held\\n"); });`,
  `gate.on("close", () => process.exitCode && process.stderr.write("the gate closed before it opened\\n"));`,
  `gate.on("error", (err) => process.stderr.write(err.message + "\\n"));`,
].join("\n");

interface TmuxStub {
  // Resolves once the nth stub to run has connected, counting from 1.
  asked(n: number): Promise<void>;
  // Lets the nth stub answer, resolving once it says it heard. Rejects,
  // naming it, when it hung up first.
  open(n: number): Promise<void>;
  // Ends every stub still waiting.
  close(): Promise<void>;
}

// One stub's connection, and how it ended if it hung up.
interface Ask {
  socket: net.Socket;
  hungUp: string | null;
}

// A `tmux` in `dir` and the gate it waits on.
async function tmuxStub(dir: string): Promise<TmuxStub> {
  writeFileSync(path.join(dir, "tmux"), STUB_TMUX, { mode: 0o755 });
  // [LAW:no-silent-failure] A stub that hangs up before its gate opens says
  // how, for the open that finds it gone.
  const asks: Ask[] = [];
  const server = net.createServer((socket) => {
    const ask: Ask = { socket, hungUp: null };
    socket.on("error", (err) => (ask.hungUp = err.message));
    socket.on("close", () => (ask.hungUp ??= "hung up"));
    asks.push(ask);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(path.join(dir, "gate"), resolve);
  });
  return {
    asked: (n) => until(() => asks.length >= n, `tmux stub #${n} asking`),
    open: (n) =>
      new Promise((resolve, reject) => {
        const ask = asks[n - 1];
        if (ask === undefined)
          return reject(new Error(`tmux stub #${n} never asked`));
        const gone = () =>
          reject(
            new Error(`tmux stub #${n} ${ask.hungUp} before its gate opened`),
          );
        if (ask.hungUp !== null) return gone();
        // A write lands in the kernel whether or not the stub is alive to
        // read it; only the stub's answer back says it heard.
        ask.socket.once("data", () => resolve()).once("close", gone);
        ask.socket.write("open\n");
      }),
    close: () =>
      new Promise((resolve, reject) => {
        for (const { socket } of asks) socket.destroy();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

type Event = {
  level: string;
  fields: ReadonlyArray<readonly [string, string]>;
};

// A request event's level and its `key=value` fields, in order. A value that
// could be misread as more than one field is a JSON string, read whole and
// unquoted.
function eventOf(line: string): Event {
  const [, level, rest] = line.match(/ \[(\w+)\] (?:render|click) (.*)$/)!;
  const fields = [...rest!.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(
    ([, key, value]) =>
      [
        key!,
        value!.startsWith('"') ? (JSON.parse(value!) as string) : value!,
      ] as const,
  );
  return { level: level!, fields };
}

// The one event a case expects, or a failure naming how many there were.
function only(events: readonly Event[]): Event {
  const [event, ...rest] = events;
  if (event === undefined || rest.length > 0)
    throw new Error(`expected exactly one render event, got ${events.length}`);
  return event;
}

const field = (event: Event, key: string): string | undefined =>
  event.fields.find(([k]) => k === key)?.[1];

// A session's render event lines, picked so a wait that fails names them.
const renderLinesOf = (sid: string, lines: readonly string[]): string[] =>
  lines.filter(
    (l) => / \[\w+\] render /.test(l) && field(eventOf(l), "sid") === sid,
  );

// A session's events once at least `count` have landed.
const landedEvents = async (
  env: NodeJS.ProcessEnv,
  sid: string,
  count: number,
): Promise<Event[]> =>
  (
    await loggedLines(
      env,
      (lines) => renderLinesOf(sid, lines),
      (found) => found.length >= count,
      `${count} render event(s) for ${sid}`,
    )
  ).map(eventOf);

// A session id that would forge a field, and a second event, were it written
// into the line as it was sent.
const FORGING_SID = 'ev drawn outcome=threw\n2026-01-01 [error] render sid="x"';

describe("every render request writes one render event, whatever its outcome", () => {
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let daemon: InWorkerDaemon;

  const configFlag = (name: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${name}.json5`),
  ];
  const renderEvents = (lines: readonly string[] = logLines(env)): Event[] =>
    lines.filter((l) => / \[\w+\] render /.test(l)).map(eventOf);
  const clickEvents = (lines: readonly string[]): Event[] =>
    lines.filter((l) => / \[\w+\] click /.test(l)).map(eventOf);
  // What has landed so far: for what must not have been written.
  const eventsNow = (
    sid: string,
    lines: readonly string[] = logLines(env),
  ): Event[] => renderLinesOf(sid, lines).map(eventOf);
  const eventsOf = (sid: string, count = 1): Promise<Event[]> =>
    landedEvents(env, sid, count);

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-e2e");
    ({ env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    daemon = startDaemon(prepared.env);
  });

  afterAll(async () => {
    await daemon?.stop();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a drawn bar, a broken gate and a refused request each leave an event naming their outcome", async () => {
    const hints = { termCols: 120, termRows: 40 };
    await render(daemon, FORGING_SID, projectDir, hints, configFlag("drawn"));
    // A gate that fails costs what it gates, not the bar
    // (brandon-unfiled-3248.ryf): the reply is a bar, and its event says why
    // (the indicator offers it from the next frame: daemon-render-warnings).
    const gated = stripAnsi(
      await render(
        daemon,
        "ev-gate",
        projectDir,
        hints,
        configFlag("broken"),
      ),
    );
    expect(gated).toContain(DOOR_GLYPH);
    await expect(
      renderRequest(daemon, {
        hookData: hookData("ev-refused", projectDir),
        args: [],
        cwd: "proj",
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // Args that are not a list of strings are refused at the checkpoint too,
    // never thrown past the render event by the flag parser.
    await expect(
      renderRequest(daemon, {
        hookData: hookData("ev-refused-args", projectDir),
        args: "x" as unknown as string[],
        cwd: projectDir,
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // A deadline that is not epoch milliseconds is refused, never read as a
    // client too old to state one.
    await expect(
      renderRequest(daemon, {
        hookData: hookData("ev-refused-deadline", projectDir),
        args: [],
        cwd: projectDir,
        deadline: "soon",
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // An empty session id names no session.
    await expect(
      renderRequest(daemon, {
        hookData: hookData("", projectDir),
        args: [],
        cwd: projectDir,
      }),
    ).rejects.toThrow(/BAD_REQUEST/);

    // A request the helper retried after a reply timeout is logged once per
    // attempt: every attempt ended the same way, and exactly one of them is
    // the reply the client read.
    const attempts = async (
      sid: string,
      outcome: string,
      level: string,
    ): Promise<Event> => {
      const events = (
        await loggedLines(
          env,
          (lines) => renderLinesOf(sid, lines),
          (found) => found.some((l) => field(eventOf(l), "timedOut") === "N"),
          `the answered render event for ${sid}`,
        )
      ).map(eventOf);
      for (const event of events) {
        expect(event.level).toBe(level);
        expect(field(event, "outcome")).toBe(outcome);
      }
      return only(events.filter((e) => field(e, "timedOut") === "N"));
    };
    // The forging sid is read back whole, as one field of one event.
    const drawn = await attempts(FORGING_SID, "ok", "info");
    expect(eventsNow("x")).toEqual([]);

    // Which client drew the bar: the program a hint names, and `unreported`
    // for a client too old to say (brandon-doctor-v62x.tfb).
    expect(field(drawn, "client")).toBe("unreported");
    // Which animation lanes the session's settings switch on: none by default.
    expect(field(drawn, "lanes")).toBe("-");
    // The sources a render drew as not answered yet: none on a bar whose
    // values are all in, the source's name where one is not
    // (brandon-unfiled-3248.8ro6).
    expect(field(drawn, "pending")).toBe("-");
    // How long the request was queued, from the connection's accept, before
    // its render began, and how long it waited for its refreshes: whole
    // milliseconds. Their size is the machine's, not the daemon's to promise.
    expect(field(drawn, "queued")).toMatch(/^\d+ms$/u);
    expect(field(drawn, "waited")).toMatch(/^\d+ms$/u);
    // How the wait ended — every refresh it waited on answered, or its
    // client's deadline came first, as it can for the daemon's first render,
    // which compiles the config in its arrival turn — and how long the turn
    // after it took to make the answer, which the draw's reserve is held to.
    expect(field(drawn, "ended")).toMatch(/^(answered|deadline)$/u);
    expect(field(drawn, "drew")).toMatch(/^\d+ms$/u);
    // How each globals rule settled: none on a bar that names its look, and
    // per slot where rules choose it — kept outside the draw, or evaluated at
    // the frame's instant (brandon-unfiled-3248.8ro6, 4e).
    expect(field(drawn, "rules")).toBe("-");
    await render(daemon, "ev-ruled", projectDir, hints, configFlag("ruled"));
    expect(field(await attempts("ev-ruled", "ok", "info"), "rules")).toBe(
      "style:kept,effect:per-draw",
    );
    // One request, the answer it got: a source that never answers draws
    // pending however often it is asked. The config's entry is compiled
    // first, by another session's request: a compile is its arrival turn's,
    // and on a slow machine outlives the backstop.
    await sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...renderBody(
        "ev-pending-warm",
        projectDir,
        hints,
        configFlag("waiting"),
      ),
    });
    await eventsOf("ev-pending-warm");
    const asked = await sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...renderBody("ev-pending", projectDir, hints, configFlag("waiting")),
    });
    expect(asked).toMatchObject({ ok: true });
    const waiting = stripAnsi((asked as { output: string }).output);
    expect(waiting).toContain("…");
    expect(waiting).not.toContain("⚠");
    expect(field(await attempts("ev-pending", "ok", "info"), "pending")).toBe(
      "doc",
    );
    // How many of its view's parts a render evaluated: all of them cold, and
    // only those whose inputs moved when the session draws the same data
    // again (brandon-unfiled-3248.8ro6).
    await render(daemon, "ev-kept", projectDir, hints, configFlag("drawn"));
    await render(daemon, "ev-kept", projectDir, hints, configFlag("drawn"));
    const keptEvents = await eventsOf("ev-kept", 2);
    const [cold, kept] = keptEvents.map((e) => Number(field(e, "evaluated")));
    expect(cold).toBeGreaterThan(0);
    expect(kept).toBeLessThan(cold!);
    // A warm render's wait answers inside its deadline.
    expect(field(keptEvents[1]!, "ended")).toBe("answered");
    await render(
      daemon,
      "ev-native",
      projectDir,
      {
        ...hints,
        client: { kind: "native", bundle: "/b/dist/index.mjs", source: null },
      },
      configFlag("drawn"),
    );
    expect(field(await attempts("ev-native", "ok", "info"), "client")).toBe(
      "native",
    );

    // What the hook payload said of the rate-limit windows — the sighting the
    // doctor's segment-data check reads (brandon-doctor-v62x.onf).
    expect(field(drawn, "rateLimits")).toBe("missing");
    const body = renderBody(
      "ev-windows",
      projectDir,
      hints,
      configFlag("drawn"),
    );
    await renderRequest(daemon, {
      ...body,
      hookData: {
        ...hookData("ev-windows", projectDir),
        rate_limits: { five_hour: { used_percentage: 10, resets_at: 0 } },
      },
    });
    expect(
      field(await attempts("ev-windows", "ok", "info"), "rateLimits"),
    ).toBe("carried");

    // The broken gate is a render that finished, warning which gate it was;
    // its fields are the drawn bar's, in the same order.
    const gate = await attempts("ev-gate", "ok", "info");
    expect(field(gate, "warn")).toBe("when");
    const keys = (event: Event) => event.fields.map(([k]) => k);
    expect(keys(gate)).toEqual(keys(drawn));

    // A refused request names its problems. The request was not trusted, so
    // nothing it said is recorded as a fact of the render — not even its sid.
    const badRequests = (lines: readonly string[]): string[] =>
      lines.filter(
        (l) =>
          / \[\w+\] render /.test(l) &&
          field(eventOf(l), "outcome") === "bad-request",
      );
    const refused = (
      await loggedLines(
        env,
        badRequests,
        (found) => found.length >= 4,
        "the refused requests' events",
      )
    ).map(eventOf);
    expect(refused.map((e) => field(e, "problems"))).toEqual([
      `request 'cwd' is not an absolute path: "proj"`,
      `request 'args' is not a list of strings: "x"`,
      `request 'deadline' is not epoch milliseconds: "soon"`,
      "field 'session_id' is empty",
    ]);
    for (const event of refused) {
      expect(event.level).toBe("warn");
      expect(field(event, "sid")).toBeUndefined();
    }
    // The log has one writer, in order: once a later render's event has
    // landed, any line the requests above wrote has too.
    await render(daemon, "ev-after", projectDir, {});
    const after = await loggedWhen(
      env,
      (lines) =>
        renderEvents(lines).some((e) => field(e, "sid") === "ev-after"),
      "a later render's event",
    );
    expect(after.join("\n")).not.toContain("handler threw");
  });

  // A failed click's error shows on every render inside its hold, and past it
  // on a request until an answer has carried it — what a bar Claude Code
  // redraws only on events needs — then on none.
  // [LAW:nothing-unseen] A click is a unit of work like a render: how long it
  // waited behind the daemon's loop is what a starved click looks like.
  test("every click request writes one click event: the verb it ran, its session, how long it queued and took, and how it ended", async () => {
    const sid = "ev-click-event";
    await render(daemon, sid, projectDir, {}, configFlag("drawn"));
    const open = effectsUrl([
      { verb: VERB_SET_STATE, args: [sid, "candybar.menu", "open"] },
    ]);
    expect((await sendClick(daemon, open)).ok).toBe(true);
    const unknown = await sendClick(daemon, "cc-candybar://no-such-verb/x");
    expect(unknown.ok).toBe(false);
    // A session id the checkpoint refuses: its verb refuses the click.
    const badSession = effectsUrl([
      { verb: VERB_SET_STATE, args: ["../x", "candybar.menu", "open"] },
    ]);
    expect((await sendClick(daemon, badSession)).ok).toBe(false);
    // A verb that names no session, refused before it launches anything.
    expect((await sendClick(daemon, "cc-candybar://copy/%E0")).ok).toBe(
      false,
    );
    const refusedBy = (ls: readonly string[], needle: string): Event[] =>
      clickEvents(ls).filter((e) => field(e, "problems")?.includes(needle));
    const lines = await loggedWhen(
      env,
      (ls) =>
        refusedBy(ls, "no-such-verb").length > 0 &&
        refusedBy(ls, "session id").length > 0 &&
        clickEvents(ls).some((e) => field(e, "verb") === "copy"),
      "the refused clicks' events",
    );
    const opened = only(
      clickEvents(lines).filter((e) => field(e, "sid") === sid),
    );
    expect(opened.level).toBe("info");
    expect(opened.fields.map(([key]) => key)).toEqual([
      "queued",
      "verb",
      "sid",
      "timedOut",
      "took",
      "outcome",
    ]);
    expect(field(opened, "verb")).toBe("dispatch");
    expect(field(opened, "queued")).toMatch(/^\d+ms$/);
    expect(field(opened, "took")).toMatch(/^\d+ms$/);
    expect(field(opened, "timedOut")).toBe("N");
    expect(field(opened, "outcome")).toBe("ok");
    // Refused before its verb was known: no verb, no session. The client's
    // text is in the problem, never a field.
    const unknownVerb = only(refusedBy(lines, "no-such-verb"));
    expect(unknownVerb.level).toBe("warn");
    expect(unknownVerb.fields.map(([key]) => key)).toEqual([
      "queued",
      "timedOut",
      "took",
      "outcome",
      "problems",
    ]);
    expect(field(unknownVerb, "outcome")).toBe("bad-request");
    expect(field(unknownVerb, "problems")).toBe(
      "unknown click verb: no-such-verb",
    );
    // A session id that fails the checkpoint is never recorded as one.
    const unparsed = only(refusedBy(lines, "session id"));
    expect(unparsed.fields.map(([key]) => key)).toEqual([
      "queued",
      "verb",
      "timedOut",
      "took",
      "outcome",
      "problems",
    ]);
    expect(field(unparsed, "outcome")).toBe("bad-request");
    // A click naming no session says so: `-`, not absent.
    const sessionless = only(
      clickEvents(lines).filter((e) => field(e, "verb") === "copy"),
    );
    expect(field(sessionless, "sid")).toBe("-");
  });

  // A click the daemon cannot read still writes its event, refused as the
  // client's fault: no throw escapes the click to skip it.
  test("a click whose fields or encoding are malformed is a bad-request click event", async () => {
    const notStrings = await sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "click",
      verb: "dispatch",
      value: 5,
    });
    expect(notStrings).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    const badEscape = await sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "click",
      verb: VERB_TMUX_STATUS_CLICK,
      value: "%E0/1/r",
    });
    expect(badEscape).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    const refusedBy = (ls: readonly string[], needle: string): Event[] =>
      clickEvents(ls).filter((e) => field(e, "problems")?.includes(needle));
    const lines = await loggedWhen(
      env,
      (ls) =>
        refusedBy(ls, "are strings").length > 0 &&
        refusedBy(ls, "needs <socket>/<pane>/<range>").length > 0,
      "the malformed clicks' events",
    );
    const fields = only(refusedBy(lines, "are strings"));
    expect(fields.level).toBe("warn");
    expect(fields.fields.map(([key]) => key)).toEqual([
      "queued",
      "timedOut",
      "took",
      "outcome",
      "problems",
    ]);
    // The status-line verb is known, so it is recorded before the value its
    // decode refused.
    const escape = only(refusedBy(lines, "needs <socket>/<pane>/<range>"));
    expect(field(escape, "verb")).toBe(VERB_TMUX_STATUS_CLICK);
    expect(field(escape, "outcome")).toBe("bad-request");
  });

  // Every request carries a field the schema does not know, so it is said
  // once per daemon, and the stats list it for as long as the daemon lives.
  test("an unknown hook field is logged once per daemon and listed in its stats, and a refused request's is neither", async () => {
    const sid = "ev-unknown-field";
    const request = {
      ...renderBody(sid, projectDir, {}, configFlag("drawn")),
      hookData: { ...hookData(sid, projectDir), novel_field_9b04: 1 },
    };
    // Answered before the others are sent, so its field had its chance.
    const refused = await sendDaemonRequest(daemon, {
      ...request,
      cwd: "relative",
      hookData: { ...hookData(sid, projectDir), refused_field_9b04: 1 },
    });
    expect(refused.ok).toBe(false);
    await renderRequest(daemon, request);
    await renderRequest(daemon, request);
    // Each line lands before its request's render event, in the log's order.
    await eventsOf(sid, 2);
    expect(
      logLines(env).filter((l) =>
        l.includes('schema: unknown field "novel_field_9b04"'),
      ),
    ).toHaveLength(1);
    const resp = await sendDaemonRequest(daemon, {
      v: PROTOCOL_VERSION,
      kind: "stats",
    });
    expect(
      resp.ok && "stats" in resp ? resp.stats.unknownHookFields : resp,
    ).toContain("novel_field_9b04");
    expect(
      resp.ok && "stats" in resp ? resp.stats.unknownHookFields : resp,
    ).not.toContain("refused_field_9b04");
    expect(
      logLines(env).filter((l) => l.includes("refused_field_9b04")),
    ).toEqual([]);
  });

  // The kind is untrusted JSON: one no request carries — a name, or a value a
  // property lookup would coerce into one — is refused, never thrown on.
  test("a request of a kind no request carries is refused BAD_REQUEST", async () => {
    for (const kind of ["nope", ["click"], 7])
      await expect(
        sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind }),
      ).resolves.toEqual({
        ok: false,
        error: "unknown kind",
        code: "BAD_REQUEST",
        daemonV: PROTOCOL_VERSION,
      });
  });

  // Rule 1 of the model (brandon-unfiled-3248.8ro6): an answer shows what its
  // request carried. A shell keyed on the model re-runs in the turn a request
  // moves the model, and that request's answer waits for the re-run inside
  // its deadline, rather than drawing the previous model's output. The
  // command counts its runs, so the output names which run drew it.
  test("a request that moves a shell's key is answered with the re-run's output", async () => {
    const runs = path.join(projectDir, "keyed-runs");
    const config = path.join(projectDir, "keyed.json5");
    writeFileSync(
      config,
      `{ variables: { mid: { kind: 'input', path: 'model.id', default: '' }, runs: { kind: 'shell', command: 'sleep 0.02; n=$(($(cat ${runs} 2>/dev/null || echo 0) + 1)); echo $n > ${runs}; echo run$n', cache: { key: '{{ .mid }}' } } }, segments: { mark: { template: '{{ .runs }}' } }, root: { h: ['mark'] } }`,
    );
    const ask = (model: string) => {
      const body = renderBody("ev-keyed", projectDir, {}, [
        "cc-candybar",
        "--config",
        config,
      ]);
      return renderRequest(daemon, {
        ...body,
        hookData: {
          ...(body.hookData as object),
          model: { id: model, display_name: model },
        },
        // A client with time to spare: the wait runs to the daemon's own
        // backstop, less the draw's reserve.
        deadline: Date.now() + 5_000,
      });
    };
    const revision = async (): Promise<number> => {
      const resp = await sendDaemonRequest(daemon, {
        v: PROTOCOL_VERSION,
        kind: "stats",
      });
      return (resp as { stats: { sessionState: { revision: number } } }).stats
        .sessionState.revision;
    };
    // The first request compiles the config's entry in its arrival turn,
    // which can spend its whole deadline: what it draws is not this case's.
    // Its run lands on its own.
    await ask("model-a");
    await until(
      () => existsSync(runs) && readFileSync(runs, "utf8") === "1\n",
      "the first run landing",
    );
    expect(stripAnsi(await ask("model-b"))).toContain("run2");
    // Its deadline is the request's own, never one of the session's facts: a
    // request that differs from the last only by it moves no session state.
    const before = await revision();
    expect(stripAnsi(await ask("model-b"))).toContain("run2");
    expect(await revision()).toBe(before);
    for (const event of (await eventsOf("ev-keyed", 3)).slice(1))
      expect(field(event, "ended")).toBe("answered");
  });

  // The connection's backstop answers TIMEOUT whatever the render is still
  // doing. A wait ends before it, so what outlives it is a synchronous turn:
  // here the first request's compile of a config big enough to take several
  // times the backstop. The render's event says the client read another
  // reply, and the hold it drew under is released when it ends. Last, since
  // so big a compile slows whatever the daemon does next.
  test("a render that outlives its request timeout writes timedOut=Y", async () => {
    const segments = Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [
        `s${i}`,
        { template: `{{ .session.id }} ${i}` },
      ]),
    );
    const config = path.join(projectDir, "heavy.json5");
    writeFileSync(
      config,
      JSON.stringify({
        variables: {
          slow: {
            kind: "shell",
            command: "sleep 0.05; echo slow",
            cache: { key: "once" },
          },
        },
        segments: { ...segments, slow: { template: "{{ .slow }}" } },
        root: { h: [...Object.keys(segments), "slow"] },
      }),
    );
    // [LAW:no-ambient-temporal-coupling] The backstop's TIMEOUT reply is a
    // task on the daemon's loop, so it cannot be written until the
    // synchronous compile yields: this client's wait is bounded by the
    // compile, seconds on CI's two cores, not by the backstop. The running
    // source is what yields: with nothing in flight the answer is written on
    // microtasks, ahead of the overdue backstop. The helper's
    // default budget is for an answered request, so the budget here is the
    // test's own timeout, and nothing ends the wait before Jest would. The
    // event's `took` below is what says the render outlived the backstop.
    await expect(
      sendDaemonRequest(
        daemon,
        {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody("ev-backstop", projectDir, {}, [
            "cc-candybar",
            "--config",
            config,
          ]),
          deadline: Date.now() + TOTAL_BUDGET_MS,
        },
        TEST_TIMEOUT_MS,
      ),
    ).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
    const late = only(await eventsOf("ev-backstop"));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("Y");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(daemon, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  });
});

// A request is answered by its client's deadline, whatever its sources are
// still doing (brandon-unfiled-3248.8ro6, §4c): a source still reading then
// draws as pending, and lands for the session's next render. The tmux stub
// answers only once the test opens the gate, so the source provably outlives
// the deadline — an ordering the test owns, not a bet on how slow a render is.
// A real process, because that answer's cold first draw has to fit the draw's
// reserve in wall time, the bound test/draw-reserve.test.ts holds.
describe("a client's deadline", () => {
  let env: NodeJS.ProcessEnv;
  let sockPath: string;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let tmuxDir: string;
  let args: string[];
  let stub: TmuxStub | undefined;
  let daemon: RunningDaemon | undefined;

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-deadline");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    const config = path.join(projectDir, "held.json5");
    writeFileSync(config, CONFIGS.held);
    args = ["cc-candybar", "--config", config];
    tmuxDir = path.join(projectDir, "bin");
    mkdirSync(tmuxDir);
    stub = await tmuxStub(tmuxDir);
    daemon = await spawnDaemonWithEnv({
      ...prepared.env,
      PATH: `${tmuxDir}${path.delimiter}${prepared.env.PATH ?? ""}`,
    });
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    await stub?.close();
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a source that outlives its client's deadline draws pending, and lands for the next render", async () => {
    const tmuxBody = (sid: string, pane: string) =>
      renderBody(
        sid,
        projectDir,
        {
          // A socket inside the test's own directory: were the stub ever
          // bypassed, a real tmux would find no server there.
          tmux: {
            socket: path.join(tmuxDir, "tmux.sock"),
            pane,
            truecolor: null,
          },
        },
        args,
      );
    const stats = () =>
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" });

    // The config's entry compiled first, by a render that reports no pane,
    // so the deadline below is spent on the wait, not on a compile.
    await renderRequest(sockPath, {
      ...tmuxBody("ev-late-warm", "%0"),
      tmux: null,
    });
    // A client that states its deadline, as the native one does: its budget
    // counted from before it connects.
    const deadline = Date.now() + TOTAL_BUDGET_MS;
    const stated = await sendDaemonRequest(sockPath, {
      v: PROTOCOL_VERSION,
      kind: "render",
      ...tmuxBody("ev-late", "%1"),
      deadline,
    });
    expect(Date.now()).toBeLessThanOrEqual(deadline);
    expect(stated).toMatchObject({ ok: true });
    expect(stripAnsi((stated as { output: string }).output)).toContain("…");
    await stub!.asked(1);
    const late = only(await landedEvents(env, "ev-late", 1));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("N");
    expect(field(late, "deadline")).toMatch(/^stated:\d+ms$/u);
    expect(field(late, "ended")).toBe("deadline");
    expect(field(late, "pending")).toBe("tmux.session");
    // Answered, it holds nothing, though its source reads on: `using`
    // released the hold on exit.
    await expect(stats()).resolves.toMatchObject({
      ok: true,
      stats: { renderCache: { held: 0, retired: 0 } },
    });

    // The read lands, and the session's next render draws it, waiting on
    // nothing.
    await stub!.open(1);
    await loggedWhen(
      env,
      (lines) => lines.some((l) => / tmux refresh .* outcome=ok /u.test(l)),
      "tmux's read landing",
    );
    const drawn = stripAnsi(
      await renderRequest(sockPath, tmuxBody("ev-late", "%1")),
    );
    expect(drawn).toContain("held");
    expect(field((await landedEvents(env, "ev-late", 2))[1]!, "ended")).toBe("answered");

    // A client too old to state its deadline is answered by the earliest an
    // old client gives up at — the native client's, whose budget runs from
    // before its connect — so within its whole budget, the connect included.
    const sent = Date.now();
    await expect(
      sendDaemonRequest(sockPath, {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...tmuxBody("ev-late-unstated", "%2"),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(Date.now() - sent).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
    const unstated = only(await landedEvents(env, "ev-late-unstated", 1));
    expect(field(unstated, "deadline")).toMatch(/^unstated:\d+ms$/u);
    expect(field(unstated, "ended")).toBe("deadline");
    // Its stub is still reading: let it answer rather than be killed.
    await stub!.asked(2);
    await stub!.open(2);
  });
});

describe("a failed click's error", () => {
  test("is the render event's clickError: held, owed, then over", async () => {
    const { env, removeTmpDirs } = prepareIsolatedDaemonEnv(
      "cc-candybar-event-click",
    );
    const projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    const config = path.join(projectDir, "drawn.json5");
    writeFileSync(config, CONFIGS.drawn);
    const args = ["cc-candybar", "--config", config];
    const clock = heldClock();
    const daemon = startDaemon(env, { clock });
    try {
      const sid = "ev-click";
      let sent = 0;
      const renderOne = async (): Promise<Event> => {
        await render(daemon, sid, projectDir, {}, args);
        return (await landedEvents(env, sid, ++sent)).at(-1)!;
      };
      expect(field(await renderOne(), "clickError")).toBe("-");
      const bad = effectsUrl([
        { verb: VERB_SET_STATE, args: [sid, "no-such-key", "x"] },
      ]);
      expect((await sendClick(daemon, bad)).ok).toBe(false);
      const held = await renderOne();
      expect(field(held, "clickError")).toBe("held");
      expect(field(held, "err")).toBe("Y");
      // That answer carried the first failure; this one no answer carries
      // inside its hold. A request whose client is gone before its answer is
      // written is answered to no one, so it carries nothing.
      expect((await sendClick(daemon, bad)).ok).toBe(false);
      const rendered = renderLinesOf(sid, logLines(env)).length;
      // Sent and half-closed at once: the daemon's side ends with it, before
      // the render's answer is written. It reads what it is sent, because a
      // memory end finishes only once its peer has read to the end, and an
      // answer no one reads would look delivered to no one with or without
      // the half-close.
      const gone = daemon.connect();
      gone.resume();
      gone.end(
        encodeFrame({
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody(sid, projectDir, {}, args),
        }),
      );
      sent = rendered + 1;
      expect(field((await landedEvents(env, sid, sent)).at(-1)!, "clickError")).toBe(
        "held",
      );
      clock.advance((CLICK_ERROR_HOLD_S + 0.2) * 1000);
      const owed = await renderOne();
      expect(field(owed, "clickError")).toBe("owed");
      expect(field(owed, "err")).toBe("Y");
      const over = await renderOne();
      expect(field(over, "clickError")).toBe("over");
      expect(field(over, "err")).toBe("N");
    } finally {
      await daemon.stop();
      rmSync(projectDir, { recursive: true, force: true });
      removeTmpDirs();
    }
  });
});

describe("the tmux stub's wait is its gate's", () => {
  // [LAW:no-ambient-temporal-coupling] Started here, leading its own process
  // group, the stub is out of reach of anything that kills this test, and no
  // lifeline holds it. Only its gate ends it, so a run that ends before the
  // gate opens leaves nothing behind.
  test("a stub whose gate closes before it opens exits", async () => {
    const dir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    const stub = await tmuxStub(dir);
    const child = spawn(path.join(dir, "tmux"), [], {
      detached: true,
      stdio: "ignore",
    });
    try {
      // A spawn that fails rejects here, by name, and the gate closes
      // whichever way this ends.
      await Promise.all([once(child, "spawn"), stub.asked(1)]).finally(() =>
        stub.close(),
      );
      // Bounded, so a stub that ignores its gate fails this test by name and
      // the cleanup below still runs.
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "the stub exiting once its gate closed",
      );
      expect([child.exitCode, child.signalCode]).toEqual([1, null]);
    } finally {
      // A failed run leaves no stub either. The stub is node itself, so the
      // child is the whole of it.
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
