// [LAW:nothing-unseen] brandon-unfiled-3248.87p, measured on a REAL daemon:
// every render request writes one render event — the `render …` log line —
// whatever its outcome. A render that draws the bar, one whose config fails
// partway (a broken gate), and one the daemon refuses each leave an event
// naming its outcome. The event's own fields, and the threw arm a renderer
// bug reaches, are held by test/request-event.test.ts.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants, open } from "node:fs/promises";
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
import { logLines, loggedWhen } from "./helpers/daemon-log";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { until } from "./helpers/until";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

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

// [LAW:no-ambient-temporal-coupling] The `tmux` on the daemon's PATH: it holds
// the gate beside it open for reading — a FIFO, opened read-write so the open
// itself does not wait for a writer — then says it was asked, and answers only
// once the test writes a line into the gate. `asked` therefore means "reading":
// the test opens the gate after the client has been answered TIMEOUT, so the
// render provably outlives the request timeout, an ordering the test owns, not
// a bet on how slow a render is. Only a render whose client reports a tmux pane
// runs it, and src/proc/tmux.ts kills it at 2 s, so a test that never opens the
// gate leaves no stub behind.
const STUB_TMUX = `#!/bin/sh
here=$(dirname "$0")
exec 3<> "$here/gate"
: > "$here/asked"
read _ <&3
echo held
`;

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

// A session id that would forge a field, and a second event, were it written
// into the line as it was sent.
const FORGING_SID = 'ev drawn outcome=threw\n2026-01-01 [error] render sid="x"';

describe("every render request writes one render event, whatever its outcome", () => {
  let sockPath: string;
  let env: NodeJS.ProcessEnv;
  let removeTmpDirs: () => void;
  let projectDir: string;
  let tmuxDir: string;
  let daemon: RunningDaemon | undefined;

  const configFlag = (name: keyof typeof CONFIGS): string[] => [
    "cc-candybar",
    "--config",
    path.join(projectDir, `${name}.json5`),
  ];
  const renderEvents = (lines: readonly string[] = logLines(env)): Event[] =>
    lines.filter((l) => / \[\w+\] render /.test(l)).map(eventOf);
  const clickEvents = (lines: readonly string[]): Event[] =>
    lines.filter((l) => / \[\w+\] click /.test(l)).map(eventOf);
  const field = (event: Event, key: string): string | undefined =>
    event.fields.find(([k]) => k === key)?.[1];
  // What has landed so far: for what must not have been written.
  const eventsNow = (sid: string, lines?: readonly string[]): Event[] =>
    renderEvents(lines).filter((e) => field(e, "sid") === sid);
  // A session's events once at least `count` have landed.
  const eventsOf = async (sid: string, count = 1): Promise<Event[]> =>
    eventsNow(
      sid,
      await loggedWhen(
        env,
        (lines) => eventsNow(sid, lines).length >= count,
        `${count} render event(s) for ${sid}`,
      ),
    );

  beforeAll(async () => {
    const prepared = prepareIsolatedDaemonEnv("cc-candybar-event-e2e");
    ({ sockPath, env, removeTmpDirs } = prepared);
    projectDir = mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-render-event-e2e-"),
    );
    for (const [name, text] of Object.entries(CONFIGS))
      writeFileSync(path.join(projectDir, `${name}.json5`), text);
    tmuxDir = path.join(projectDir, "bin");
    mkdirSync(tmuxDir);
    execFileSync("mkfifo", [path.join(tmuxDir, "gate")]);
    writeFileSync(path.join(tmuxDir, "tmux"), STUB_TMUX, { mode: 0o755 });
    daemon = await spawnDaemonWithEnv({
      ...prepared.env,
      PATH: `${tmuxDir}${path.delimiter}${prepared.env.PATH ?? ""}`,
    });
  });

  afterAll(async () => {
    if (daemon) await killAndWait(daemon);
    rmSync(projectDir, { recursive: true, force: true });
    removeTmpDirs();
  });

  test("a drawn bar, a broken gate and a refused request each leave an event naming their outcome", async () => {
    const hints = { termCols: 120, termRows: 40 };
    await render(sockPath, FORGING_SID, projectDir, hints, configFlag("drawn"));
    // A gate that fails costs what it gates, not the bar
    // (brandon-unfiled-3248.ryf): the reply is a bar, its strip saying why.
    const gated = stripAnsi(
      await render(
        sockPath,
        "ev-gate",
        projectDir,
        hints,
        configFlag("broken"),
      ),
    );
    expect(gated).toContain(
      "when over mark: the gate broke — what it gates is hidden",
    );
    await expect(
      renderRequest(sockPath, {
        hookData: hookData("ev-refused", projectDir),
        args: [],
        cwd: "proj",
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // Args that are not a list of strings are refused at the checkpoint too,
    // never thrown past the render event by the flag parser.
    await expect(
      renderRequest(sockPath, {
        hookData: hookData("ev-refused-args", projectDir),
        args: "x" as unknown as string[],
        cwd: projectDir,
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // A deadline that is not epoch milliseconds is refused, never read as a
    // client too old to state one.
    await expect(
      renderRequest(sockPath, {
        hookData: hookData("ev-refused-deadline", projectDir),
        args: [],
        cwd: projectDir,
        deadline: "soon",
      }),
    ).rejects.toThrow(/BAD_REQUEST/);
    // An empty session id names no session.
    await expect(
      renderRequest(sockPath, {
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
      const events = eventsNow(
        sid,
        await loggedWhen(
          env,
          (lines) =>
            eventsNow(sid, lines).some((e) => field(e, "timedOut") === "N"),
          `the answered render event for ${sid}`,
        ),
      );
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
    await render(sockPath, "ev-ruled", projectDir, hints, configFlag("ruled"));
    expect(field(await attempts("ev-ruled", "ok", "info"), "rules")).toBe(
      "style:kept,effect:per-draw",
    );
    // One request, the answer it got: a source that never answers draws
    // pending however often it is asked. The config's entry is compiled
    // first, by another session's request: a compile is its arrival turn's,
    // and on a slow machine outlives the backstop.
    await sendDaemonRequest(sockPath, {
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
    const asked = await sendDaemonRequest(sockPath, {
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
    await render(sockPath, "ev-kept", projectDir, hints, configFlag("drawn"));
    await render(sockPath, "ev-kept", projectDir, hints, configFlag("drawn"));
    const keptEvents = await eventsOf("ev-kept", 2);
    const [cold, kept] = keptEvents.map((e) => Number(field(e, "evaluated")));
    expect(cold).toBeGreaterThan(0);
    expect(kept).toBeLessThan(cold!);
    // A warm render's wait answers inside its deadline.
    expect(field(keptEvents[1]!, "ended")).toBe("answered");
    await render(
      sockPath,
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
    await renderRequest(sockPath, {
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
    // Its strip's full text was written beside it.
    expect(field(gate, "dumpFailed")).toBe("-");
    const keys = (event: Event) => event.fields.map(([k]) => k);
    expect(keys(gate)).toEqual(keys(drawn));

    // A refused request names its problems. The request was not trusted, so
    // nothing it said is recorded as a fact of the render — not even its sid.
    const badRequests = (lines?: readonly string[]) =>
      renderEvents(lines).filter((e) => field(e, "outcome") === "bad-request");
    const refused = badRequests(
      await loggedWhen(
        env,
        (lines) => badRequests(lines).length >= 4,
        "the refused requests' events",
      ),
    );
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
    await render(sockPath, "ev-after", projectDir, {});
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
  test("a failed click's error is the render event's clickError: held, owed, then over", async () => {
    const sid = "ev-click";
    let sent = 0;
    const renderOne = async (): Promise<Event> => {
      await render(sockPath, sid, projectDir, {}, configFlag("drawn"));
      return (await eventsOf(sid, ++sent)).at(-1)!;
    };
    expect(field(await renderOne(), "clickError")).toBe("-");
    const bad = effectsUrl([
      { verb: VERB_SET_STATE, args: [sid, "no-such-key", "x"] },
    ]);
    expect((await sendClick(sockPath, bad)).ok).toBe(false);
    const held = await renderOne();
    expect(field(held, "clickError")).toBe("held");
    expect(field(held, "err")).toBe("Y");
    // That answer carried the first failure; this one no answer carries
    // inside its hold. A request whose client is gone before its answer is
    // written is answered to no one, so it carries nothing.
    expect((await sendClick(sockPath, bad)).ok).toBe(false);
    const rendered = eventsNow(sid).length;
    // Sent and half-closed at once: the daemon's side ends with it, before the
    // render's answer is written.
    const gone = net.connect(sockPath, () =>
      gone.end(
        encodeFrame({
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody(sid, projectDir, {}, configFlag("drawn")),
        }),
      ),
    );
    sent = rendered + 1;
    expect(field((await eventsOf(sid, sent)).at(-1)!, "clickError")).toBe(
      "held",
    );
    await new Promise((r) => setTimeout(r, (CLICK_ERROR_HOLD_S + 0.2) * 1000));
    const owed = await renderOne();
    expect(field(owed, "clickError")).toBe("owed");
    expect(field(owed, "err")).toBe("Y");
    const over = await renderOne();
    expect(field(over, "clickError")).toBe("over");
    expect(field(over, "err")).toBe("N");
  });

  // [LAW:nothing-unseen] A click is a unit of work like a render: how long it
  // waited behind the daemon's loop is what a starved click looks like.
  test("every click request writes one click event: the verb it ran, its session, how long it queued and took, and how it ended", async () => {
    const sid = "ev-click-event";
    await render(sockPath, sid, projectDir, {}, configFlag("drawn"));
    const open = effectsUrl([
      { verb: VERB_SET_STATE, args: [sid, "candybar.menu", "open"] },
    ]);
    expect((await sendClick(sockPath, open)).ok).toBe(true);
    const unknown = await sendClick(sockPath, "cc-candybar://no-such-verb/x");
    expect(unknown.ok).toBe(false);
    // A session id the checkpoint refuses: its verb refuses the click.
    const badSession = effectsUrl([
      { verb: VERB_SET_STATE, args: ["../x", "candybar.menu", "open"] },
    ]);
    expect((await sendClick(sockPath, badSession)).ok).toBe(false);
    const refusedBy = (ls: readonly string[], needle: string): Event[] =>
      clickEvents(ls).filter((e) => field(e, "problems")?.includes(needle));
    const lines = await loggedWhen(
      env,
      (ls) =>
        refusedBy(ls, "no-such-verb").length > 0 &&
        refusedBy(ls, "session id").length > 0,
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
      "took",
      "outcome",
    ]);
    expect(field(opened, "verb")).toBe("dispatch");
    expect(field(opened, "queued")).toMatch(/^\d+ms$/);
    expect(field(opened, "took")).toMatch(/^\d+ms$/);
    expect(field(opened, "outcome")).toBe("ok");
    // Refused before its verb was known: no verb, no session. The client's
    // text is in the problem, never a field.
    const unknownVerb = only(refusedBy(lines, "no-such-verb"));
    expect(unknownVerb.level).toBe("warn");
    expect(unknownVerb.fields.map(([key]) => key)).toEqual([
      "queued",
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
      "took",
      "outcome",
      "problems",
    ]);
    expect(field(unparsed, "outcome")).toBe("bad-request");
  });

  // A click the daemon cannot read still writes its event, refused as the
  // client's fault: no throw escapes the click to skip it.
  test("a click whose fields or encoding are malformed is a bad-request click event", async () => {
    const notStrings = await sendDaemonRequest(sockPath, {
      v: PROTOCOL_VERSION,
      kind: "click",
      verb: "dispatch",
      value: 5,
    });
    expect(notStrings).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    const badEscape = await sendDaemonRequest(sockPath, {
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
        refusedBy(ls, "malformed wire encoding").length > 0,
      "the malformed clicks' events",
    );
    const fields = only(refusedBy(lines, "are strings"));
    expect(fields.level).toBe("warn");
    expect(fields.fields.map(([key]) => key)).toEqual([
      "queued",
      "took",
      "outcome",
      "problems",
    ]);
    // The status-line verb is known, so it is recorded before the decode
    // that refused its value.
    const escape = only(refusedBy(lines, "malformed wire encoding"));
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
    const refused = await sendDaemonRequest(sockPath, {
      ...request,
      cwd: "relative",
      hookData: { ...hookData(sid, projectDir), refused_field_9b04: 1 },
    });
    expect(refused.ok).toBe(false);
    await renderRequest(sockPath, request);
    await renderRequest(sockPath, request);
    // Each line lands before its request's render event, in the log's order.
    await eventsOf(sid, 2);
    expect(
      logLines(env).filter((l) =>
        l.includes('schema: unknown field "novel_field_9b04"'),
      ),
    ).toHaveLength(1);
    const resp = await sendDaemonRequest(sockPath, {
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

  // A dump write the filesystem refuses costs the render nothing: the bar is
  // drawn, and its event names the refusal.
  test("a refused dump write is the render event's dumpFailed", async () => {
    const dir = path.join(stateDir(env), "diagnostics");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, ""); // a file where the directory should be
    try {
      await render(
        sockPath,
        "ev-dump-refused",
        projectDir,
        {},
        configFlag("broken"),
      );
    } finally {
      rmSync(dir, { force: true });
    }
    const event = only(await eventsOf("ev-dump-refused"));
    expect(field(event, "outcome")).toBe("ok");
    expect(JSON.parse(field(event, "dumpFailed") ?? "null")).toMatch(
      /ev-dump-refused\.txt: /,
    );
  });

  // The kind is untrusted JSON: one no request carries — a name, or a value a
  // property lookup would coerce into one — is refused, never thrown on.
  test("a request of a kind no request carries is refused BAD_REQUEST", async () => {
    for (const kind of ["nope", ["click"], 7])
      await expect(
        sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind }),
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
      return renderRequest(sockPath, {
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
      const resp = await sendDaemonRequest(sockPath, {
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

  // A request is answered by its client's deadline, whatever its sources are
  // still doing (brandon-unfiled-3248.8ro6, §4c): a source still reading then
  // draws as pending, and lands for the session's next render. The tmux stub
  // answers only once the test opens the gate, so the source provably
  // outlives the deadline — an ordering the test owns, not a bet on how slow a
  // render is.
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
        configFlag("held"),
      );
    const openGate = async (): Promise<void> => {
      // A non-blocking open fails (ENXIO) once the stub has stopped reading,
      // rather than waiting for a reader that will never come.
      const gate = await open(
        path.join(tmuxDir, "gate"),
        constants.O_WRONLY | constants.O_NONBLOCK,
      );
      await gate.write("open\n");
      await gate.close();
    };
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
    await until(
      () => existsSync(path.join(tmuxDir, "asked")),
      "the render asked tmux",
    );
    const late = only(await eventsOf("ev-late"));
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
    await openGate();
    await loggedWhen(
      env,
      (lines) => lines.some((l) => / tmux refresh .* outcome=ok /u.test(l)),
      "tmux's read landing",
    );
    const drawn = stripAnsi(
      await renderRequest(sockPath, tmuxBody("ev-late", "%1")),
    );
    expect(drawn).toContain("held");
    expect(field((await eventsOf("ev-late", 2))[1]!, "ended")).toBe("answered");

    // A client too old to state its deadline is answered by the earliest an
    // old client gives up at — the native client's, whose budget runs from
    // before its connect — so within its whole budget, the connect included.
    rmSync(path.join(tmuxDir, "asked"));
    const sent = Date.now();
    await expect(
      sendDaemonRequest(sockPath, {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...tmuxBody("ev-late-unstated", "%2"),
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(Date.now() - sent).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
    const unstated = only(await eventsOf("ev-late-unstated"));
    expect(field(unstated, "deadline")).toMatch(/^unstated:\d+ms$/u);
    expect(field(unstated, "ended")).toBe("deadline");
    // Its stub is still reading: let it answer rather than be killed.
    await until(
      () => existsSync(path.join(tmuxDir, "asked")),
      "the second render asked tmux",
    );
    await openGate();
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
      JSON.stringify({ segments, root: { h: Object.keys(segments) } }),
    );
    await expect(
      sendDaemonRequest(sockPath, {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...renderBody("ev-backstop", projectDir, {}, [
          "cc-candybar",
          "--config",
          config,
        ]),
        deadline: Date.now() + TOTAL_BUDGET_MS,
      }),
    ).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });
    const late = only(await eventsOf("ev-backstop"));
    expect(field(late, "outcome")).toBe("ok");
    expect(field(late, "timedOut")).toBe("Y");
    expect(Number(field(late, "took")?.replace(/ms$/u, ""))).toBeGreaterThan(
      REQUEST_TIMEOUT_MS,
    );
    await expect(
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" }),
    ).resolves.toMatchObject({ ok: true, stats: { renderCache: { held: 0 } } });
  });
});
