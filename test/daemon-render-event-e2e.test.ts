// [LAW:nothing-unseen] brandon-unfiled-3248.87p, measured on a REAL daemon:
// every render request writes one render event — the `render …` log line —
// whatever its outcome. A render that draws the bar, one whose config fails
// partway (a broken gate), and one the daemon refuses each leave an event
// naming its outcome. The event's own fields, and the threw arm a renderer
// bug reaches, are held by test/render-event.test.ts.

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
import os from "node:os";
import path from "node:path";

import { stripAnsi } from "./helpers/ansi";
import { PROTOCOL_VERSION } from "../src/daemon/protocol";
import { logPath, stateDir } from "../src/daemon/paths";
import {
  hookData,
  killAndWait,
  render,
  renderBody,
  renderRequest,
} from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";

jest.setTimeout(30_000);

// `drawn` draws a bar. `broken` gates a row on a `when` that fails when it is
// evaluated, which costs that row and warns. `held` reads the tmux session name, which the
// payload awaits from a `tmux` spawn (src/segments/tmux.ts) — the stub below.
const CONFIGS = {
  drawn: `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'] } }`,
  broken: `{ segments: { mark: { template: 'mark' } }, root: { h: ['mark'], when: '{{ fail "the gate broke" }}' } }`,
  held: `{ segments: { mark: { template: '{{ .tmux.session }}' } }, root: { h: ['mark'] } }`,
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

// A log line's level and its `key=value` fields, in order. A value that could
// be misread as more than one field is a JSON string, read whole and unquoted.
function eventOf(line: string): Event {
  const [, level, rest] = line.match(/ \[(\w+)\] render (.*)$/)!;
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
  const renderEvents = (): Event[] =>
    readFileSync(logPath(env), "utf8")
      .split("\n")
      .filter((l) => / \[\w+\] render /.test(l))
      .map(eventOf);
  const field = (event: Event, key: string): string | undefined =>
    event.fields.find(([k]) => k === key)?.[1];
  const eventsOf = (sid: string): Event[] =>
    renderEvents().filter((e) => field(e, "sid") === sid);

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
      await render(sockPath, "ev-gate", projectDir, hints, configFlag("broken")),
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

    // A request the helper retried after a reply timeout is logged once per
    // attempt: every attempt ended the same way, and exactly one of them is
    // the reply the client read.
    const attempts = (sid: string, outcome: string, level: string): Event => {
      const events = eventsOf(sid);
      for (const event of events) {
        expect(event.level).toBe(level);
        expect(field(event, "outcome")).toBe(outcome);
      }
      return only(events.filter((e) => field(e, "timedOut") === "N"));
    };
    // The forging sid is read back whole, as one field of one event.
    const drawn = attempts(FORGING_SID, "ok", "info");
    expect(renderEvents().filter((e) => field(e, "sid") === "x")).toEqual([]);

    // Which client drew the bar: the program a hint names, and `unreported`
    // for a client too old to say (brandon-doctor-v62x.tfb).
    expect(field(drawn, "client")).toBe("unreported");
    // Which animation lanes the session's settings switch on: none by default.
    expect(field(drawn, "lanes")).toBe("-");
    await render(
      sockPath,
      "ev-native",
      projectDir,
      { ...hints, client: { kind: "native", bundle: "/b/dist/index.mjs", source: null } },
      configFlag("drawn"),
    );
    expect(field(attempts("ev-native", "ok", "info"), "client")).toBe("native");

    // What the hook payload said of the rate-limit windows — the sighting the
    // doctor's segment-data check reads (brandon-doctor-v62x.onf).
    expect(field(drawn, "rateLimits")).toBe("missing");
    const body = renderBody("ev-windows", projectDir, hints, configFlag("drawn"));
    await renderRequest(sockPath, {
      ...body,
      hookData: {
        ...hookData("ev-windows", projectDir),
        rate_limits: { five_hour: { used_percentage: 10, resets_at: 0 } },
      },
    });
    expect(field(attempts("ev-windows", "ok", "info"), "rateLimits")).toBe(
      "carried",
    );

    // The broken gate is a render that finished, warning which gate it was;
    // its fields are the drawn bar's, in the same order.
    const gate = attempts("ev-gate", "ok", "info");
    expect(field(gate, "warn")).toBe("when");
    // Its strip's full text was written beside it.
    expect(field(gate, "dumpFailed")).toBe("-");
    const keys = (event: Event) => event.fields.map(([k]) => k);
    expect(keys(gate)).toEqual(keys(drawn));
    expect(readFileSync(logPath(env), "utf8")).not.toContain("handler threw");

    // A refused request names its problems. The request was not trusted, so
    // nothing it said is recorded as a fact of the render — not even its sid.
    const refused = renderEvents().filter(
      (e) => field(e, "outcome") === "bad-request",
    );
    expect(refused.map((e) => field(e, "problems"))).toEqual([
      `request 'cwd' is not an absolute path: "proj"`,
      `request 'args' is not a list of strings: "x"`,
    ]);
    for (const event of refused) {
      expect(event.level).toBe("warn");
      expect(field(event, "sid")).toBeUndefined();
    }
  });

  // A dump write the filesystem refuses costs the render nothing: the bar is
  // drawn, and its event names the refusal.
  test("a refused dump write is the render event's dumpFailed", async () => {
    const dir = path.join(stateDir(env), "diagnostics");
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, ""); // a file where the directory should be
    try {
      await render(sockPath, "ev-dump-refused", projectDir, {}, configFlag("broken"));
    } finally {
      rmSync(dir, { force: true });
    }
    const event = only(eventsOf("ev-dump-refused"));
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

  // A render still running when its client was answered TIMEOUT says so: its
  // event is written when it ends, after that reply, and is the one record
  // that the reply the client read was not this render's.
  test("a render that outlives its request timeout writes timedOut=Y", async () => {
    await expect(
      sendDaemonRequest(sockPath, {
        v: PROTOCOL_VERSION,
        kind: "render",
        ...renderBody(
          "ev-late",
          projectDir,
          {
            // A socket inside the test's own directory: were the stub ever
            // bypassed, a real tmux would find no server there.
            tmux: {
              socket: path.join(tmuxDir, "tmux.sock"),
              pane: "%1",
              truecolor: null,
            },
          },
          configFlag("held"),
        ),
      }),
    ).resolves.toMatchObject({ ok: false, code: "TIMEOUT" });

    await until(
      () => existsSync(path.join(tmuxDir, "asked")),
      "the render never asked tmux",
    );
    // Held at the gate, the render has written nothing yet — and holds the
    // config state it is drawing with (brandon-unfiled-3248.6rc).
    expect(eventsOf("ev-late")).toEqual([]);
    const stats = () =>
      sendDaemonRequest(sockPath, { v: PROTOCOL_VERSION, kind: "stats" });
    await expect(stats()).resolves.toMatchObject({
      ok: true,
      stats: { renderCache: { held: 1 } },
    });
    // A non-blocking open fails (ENXIO) once the stub has stopped reading,
    // rather than waiting for a reader that will never come.
    const gate = await open(
      path.join(tmuxDir, "gate"),
      constants.O_WRONLY | constants.O_NONBLOCK,
    );
    await gate.write("open\n");
    await gate.close();
    await until(
      () => eventsOf("ev-late").length > 0,
      "the held render never wrote its event",
    );

    const late = only(eventsOf("ev-late"));
    expect(field(late, "timedOut")).toBe("Y");
    expect(field(late, "outcome")).toBe("ok");
    // Returned, it holds nothing: `using` released the hold on exit.
    await expect(stats()).resolves.toMatchObject({
      ok: true,
      stats: { renderCache: { held: 0, retired: 0 } },
    });
  });
});

// Wait for a state the daemon reaches on its own clock, failing loudly at the
// deadline rather than hanging on it.
async function until(
  reached: () => boolean,
  failure: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!reached()) {
    if (Date.now() >= deadline)
      throw new Error(`${failure} within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
