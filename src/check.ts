// [LAW:verifiable-goals] `cc-candybar check [--render] [path]` — the authoring
// agent's eyes.
// Config diagnostics otherwise surface VISUALLY (an indicator beside the bar's
// settings door, read in its viewer), a channel a blind config author never
// sees.
// This command draws the bar as the daemon draws it and projects its verdict
// onto a text + exit-code contract a script can close its own loop on:
//   0 — config loads and renders (warnings, if any, on stderr)
//   1 — config is invalid (parse / validate / register / render failure)
//   2 — usage error or a named file could not be read
//
// `--render` adds one thing to that contract: the bar it rendered, on stdout
// beneath the verdict. For an author who cannot look at a live bar it is the
// only place the layout, the glyphs and the colours are readable at all.
//
// [LAW:single-enforcer] No parallel validation path: the verdict is read off
// statusline requests answered in this process by the daemon's own parts
// (src/daemon/local-bar.ts) — the host's discovery, a collector over a faked
// session's owners, the main renderer, and the request's answer — so "check
// passes" and "the daemon renders" cannot diverge. The verdict reads the
// inspection that accompanies each pass's frame.

import { configQuery } from "./config/loader/chain-places.js";
import { previewSigner } from "./click/link-signer.js";
import { locations, stateDir } from "./daemon/paths.js";
import { repoGateLines } from "./config/loader/repo-gate.js";
import { discover, readShared } from "./daemon/config-discovery/discover.js";
import type { ConfigSnapshot } from "./config/config-snapshot.js";
import type { CliPlan } from "./cli-plan.js";
import process from "node:process";
import { loadSnapshot, type ConfigLayer } from "./config/dsl-loader.js";
import {
  chainName,
  cliConfigTarget,
  requestedConfigTarget,
  type ConfigFlag,
  type RequestedTarget,
} from "./config-hint.js";
import { explicitConfigPath } from "./utils/user-path.js";
import { DEFAULT_DSL_CONFIG } from "./config/default-dsl-config.js";
import type { World } from "./host";
import { ansiOf, parseFrame, type Frame } from "./render/frame.js";
import type { StatuslineAnswer } from "./daemon/statusline-answer.js";
import type { Gates } from "./daemon/foundations/gates.js";
import { createGates } from "./daemon/foundations/gates.js";
import { instantOf } from "./utils/instant.js";
import { effectivePresetName, presetNames } from "./config/presets.js";
import {
  sessionIdOf,
  type SessionId,
} from "./daemon/foundations/session-id.js";
import { PROTOCOL_VERSION } from "./daemon/foundations/protocol.js";
import { plainEnvironment } from "./daemon/foundations/session-env.js";
import { checkRenderRequest } from "./daemon/render-checkpoint.js";
import { EMPTY_STORED_STATE } from "./renderer-interface/stored-state.js";
import type { Fault } from "./renderer-interface/noted-faults.js";
import { columnsReserving } from "./utils/terminal-width.js";
import {
  commandDaemonFacts,
  localBar,
  type RendererBuilder,
} from "./daemon/local-bar.js";
import {
  CHECK_HINTS,
  CHECK_HOME,
  checkHook,
  checkLocate,
  checkOwners,
} from "./check-fixture.js";

// [LAW:no-ambient-temporal-coupling] A fixed width keeps the verdict a function
// of the config alone, not of whichever terminal invoked the check. Templates
// evaluate in full before any width-driven wrap/pagination, so width shapes
// layout, never diagnostics.
//
// It is also the width `--render` prints at, because the printed bar is the
// one the verdict read [LAW:one-source-of-truth]. Laying the preview out at
// `process.stdout.columns` instead would bless one bar and show another, and it
// would read a terminal the author this exists for does not have — a piped
// stdout has no columns. The client reports the terminal's columns, and the
// bar is drawn that wide less Claude Code's reserve, so the fixture's client
// reports the reserve beside it.
const CHECK_WIDTH = 200;

// How long the verdict waits for an async source's runs — a shell or file
// read — before drawing with whatever it holds (and naming the stragglers as
// a warning). Generous against a slow `uptime`, short against a hung command.
// [LAW:no-ambient-temporal-coupling] One deadline every pass's wait shares, so
// a hung command costs the budget once, never once per pass.
const SOURCE_SETTLE_MS = 5000;

// The session a fresh bar is drawn for, and each other preset's beside it.
const CHECK_SESSION = "test0a1b-2c3d-4e5f-6a7b-8c9d0e1f2a3b";

// [LAW:dataflow-not-control-flow] The check result is DATA — a pure function of
// the target file's contents — discriminated into the three outcomes the exit-
// code contract projects. `checkConfig` carries the decision; `checkCommandPlan`
// only maps it to a plan, so the contract is testable without spawning a
// process or stubbing process.exit.
//
// `layers` are the files checked, lowest first; none means the bundled
// default was checked (no config file loaded — the daemon renders the same
// default in that state).
export type CheckOutcome =
  | {
      readonly kind: "clean";
      readonly layers: readonly ConfigLayer[];
      readonly warnings: readonly string[];
      readonly rendered: Frame;
    }
  | {
      readonly kind: "fatal";
      readonly layers: readonly ConfigLayer[];
      readonly message: string;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "unreadable";
      readonly path: string;
      readonly message: string;
    };

// Draw the config one target names, as the daemon would draw it, and read the
// verdict off what each draw met.
//
// With no target, the chain is discovered exactly as the daemon discovers it
// for a client with no override (project/cwd → XDG), so the file this checks
// IS the file the daemon would load from this directory, and the advisories
// are the bar's own ([LAW:one-source-of-truth]): `check` reports what the bar
// would, never a re-derivation of it. The CLI's own `$CC_CANDYBAR_CONFIG`
// enters as the target (checkCommandPlan), the way the statusline client
// sends it as a hint — a set override always names the file, so an absent one
// is `unreadable` here, never a clean verdict about the bundled default.
//
// [LAW:no-silent-failure] With an explicit target, the named file must exist
// and be readable — a missing file is `unreadable`, never a fall-through to the
// bundled default. (The daemon's --config-to-missing-file behavior — render the
// default, watch for the file to appear — is liveness for a long-running
// renderer; a verdict command must not report "clean" about a file it never
// read.)
export async function checkConfig(
  world: World,
  // The gates the daemon holds (`createGates`), so what `check` refuses is
  // what the daemon's load refuses.
  gates: Gates,
  target: string | RequestedTarget | undefined,
  cwd: string = process.cwd(),
  // [LAW:no-ambient-temporal-coupling] The settle budget is an input of the
  // verdict, so a caller that means to see the deadline reached names a
  // budget of its own instead of waiting out the command's.
  settleMs: number = SOURCE_SETTLE_MS,
  // What builds the renderer the bar is drawn by: the daemon's main renderer,
  // unless a test wraps it to watch what it presents.
  build?: RendererBuilder,
): Promise<CheckOutcome> {
  // [LAW:single-enforcer] The daemon's discovery, under the same answers: a
  // repository the bar would not run, `check` names and runs nothing of.
  const selected =
    typeof target === "object"
      ? target
      : requestedConfigTarget(
          explicitConfigPath(cwd, target, world.host.home),
          undefined,
        );
  const { snapshot, repos } = discover(
    { ...configQuery(cwd, selected), cwd },
    readShared({
      locations: locations(world.host),
      stateDir: stateDir(world.host),
    }),
  );
  // [LAW:one-source-of-truth] Readability is the one read discovery made: a
  // layer not read — not there when named, a directory, a file it could not
  // open — is the `unreadable` outcome, distinct from a file that read but is
  // invalid. [LAW:no-silent-failure] A verdict is never `clean` about a file
  // it did not read, named or searched; only a searched layer not yet written
  // is no layer.
  const unread = snapshot.chain.find(
    (l) =>
      l.content.kind === "unreadable" ||
      (l.content.kind === "absent" && l.path === selected.path),
  );
  if (unread !== undefined)
    return {
      kind: "unreadable",
      path: unread.path,
      message:
        unread.content.kind === "unreadable"
          ? unread.content.error
          : "not found",
    };
  const layers = snapshot.chain
    .filter((l) => l.content.kind === "text")
    .map((l): ConfigLayer => ({ path: l.path, role: l.role }));
  const verdict = await drawnVerdict(world, gates, snapshot, {
    cwd,
    args:
      selected.path === undefined
        ? []
        : [
            selected.source === "argument-only" ? "--config-only" : "--config",
            selected.path,
          ],
    settleMs,
    build,
  });
  // Discovery's question about a repository the bar would not run is the
  // host's to ask, so it is the host's line here too.
  const warnings = [...verdict.warnings, ...repoGateLines(repos)];
  return verdict.kind === "clean"
    ? { kind: "clean", layers, warnings, rendered: verdict.rendered }
    : { kind: "fatal", layers, message: verdict.message, warnings };
}

// One preset's bar: the session it is drawn for, the pick it opens with (none
// for the preset a fresh session opens in), and the preset that is.
interface Pass {
  readonly session: SessionId;
  readonly pick: string | null;
  readonly preset: string | null;
}

// [LAW:verifiable-goals] Every preset a session can switch to is a bar the
// daemon renders, so every one is a pass: a segment only one preset places,
// or a rule in one preset's globals, is otherwise compiled and never
// evaluated, and exit 0 blesses a bar that throws on the first switch. The
// fresh session's pass first, then each other preset's in name order, each
// drawn for a session of its own whose stored pick is that preset. The names
// are read off one parse of the chain here; each pass's draw says which
// preset it drew, which the verdict holds to the one asked. A chain that does
// not parse here draws the fresh pass alone, whose load error is the verdict.
function passesOf(
  snapshot: ConfigSnapshot,
  home: string,
): { readonly passes: readonly Pass[]; readonly dropped: number } {
  const fresh = (preset: string | null): Pass => ({
    session: sessionIdOf(CHECK_SESSION),
    pick: null,
    preset,
  });
  let loaded: ReturnType<typeof loadSnapshot>;
  try {
    // The renderer's load says what this one warns, so nothing here repeats
    // it.
    loaded = loadSnapshot(snapshot, home, DEFAULT_DSL_CONFIG, {
      warned: () => {},
    });
  } catch {
    // [LAW:no-silent-failure] The renderer's load fails the same way, and
    // its error is the fresh pass's.
    return { passes: [fresh(null)], dropped: 0 };
  }
  const { config } = loaded;
  const opens = effectivePresetName(
    null,
    config.globals.preset,
    config.presets,
  );
  const others = [...presetNames(config.presets)]
    .filter((p) => p !== opens)
    .sort();
  return {
    passes: [
      fresh(opens),
      ...others.map(
        (preset, i): Pass => ({
          session: sessionIdOf(`${CHECK_SESSION}-${i + 1}`),
          pick: preset,
          preset,
        }),
      ),
    ],
    // [LAW:no-silent-failure] A dropped plugin leaves a bar that renders, and
    // its notice is a load warning, so only the verdict can say the config
    // asked for something it did not get.
    dropped:
      loaded.installed.dropped.length +
      loaded.layers.reduce((n, l) => n + l.plugins.dropped.length, 0),
  };
}

// What one pass's draw met, from the inspection it presented.
interface PassReading {
  readonly pass: Pass;
  readonly frame: Frame | null;
  // A load error, or the placements no file declares: the config itself
  // failed, whatever its bar drew.
  readonly fatal: string | null;
  readonly failures: readonly string[];
  readonly advisories: readonly string[];
}

// [LAW:types-are-the-program] Each fault's meaning for the verdict, by kind.
// An error is the config's failure; a warning the walk met is a render error
// the bar draws past; a warning about what the bar stands on is an advisory.
// A kind this list does not name fails the verdict, naming it, until it says.
function readPass(
  pass: Pass,
  answer: StatuslineAnswer,
  settleMs: number,
): PassReading {
  if (!answer.resp.ok || !("frame" in answer.resp))
    return {
      pass,
      frame: null,
      fatal: null,
      failures: [
        `render: ${
          answer.outcome.kind !== "ok"
            ? answer.outcome.message
            : answer.resp.ok
              ? "the answer carried no frame"
              : answer.resp.error
        }`,
      ],
      advisories: [],
    };

  const frame = parseFrame(answer.resp.frame);
  if (answer.inspection === undefined)
    throw new Error(
      `renderer presented no inspection for session ${pass.session}`,
    );
  const { preset, faults, unreadSources } = answer.inspection;
  const fatal: string[] = [];
  const dropped: string[] = [];
  const failures: string[] = [];
  const advisories: string[] = [];
  const met = (fault: Fault): void => {
    switch (fault.kind) {
      case "load":
        if (fault.level === "error") fatal.push(fault.message);
        else advisories.push(fault.message);
        return;
      // [LAW:no-silent-failure] The bar draws past a placement of an
      // undeclared segment; a check refuses it, as the file's author has to
      // fix it.
      case "dropped":
        dropped.push(fault.message);
        return;
      case "refused-args":
      case "hints":
      case "click":
        failures.push(`${fault.kind}: ${fault.message}`);
        return;
      // A globals rule the render could not honour: the bar renders that
      // slot's floor with nobody watching the bar.
      case "rule":
        failures.push(`${fault.subject} rule: ${fault.message}`);
        return;
      // A placement that drew its ⚠ cell in its place, a layout `when` that
      // threw hides what it gates, and a variable that cannot refresh draws
      // its last value: a bar quietly wrong.
      case "segment":
      case "when":
      case "refresh":
        failures.push(fault.message);
        return;
      // The bar drew from facts the host could not stamp: what it shows is
      // not what the config draws.
      case "facts":
        failures.push(`facts: ${fault.message}`);
        return;
      // What the daemon itself stands on, which says nothing of the config.
      case "file-events":
      case "lifeline":
      case "launch-pipes":
      case "renderer-ended":
      case "act-failed":
      case "config-watch":
        advisories.push(fault.message);
        return;
      default:
        failures.push(`${fault.kind}: ${fault.message}`);
    }
  };
  faults.forEach(met);
  if (pass.preset !== null && preset !== pass.preset)
    failures.push(
      `render: the session asked for preset "${pass.preset}" drew preset "${preset}"`,
    );
  if (unreadSources.length > 0)
    advisories.push(
      `source${unreadSources.length === 1 ? "" : "s"} still running after ${settleMs} ms, drawn as pending: ${unreadSources.join(", ")}`,
    );
  return {
    pass,
    frame,
    fatal:
      fatal.length > 0
        ? fatal.join("\n")
        : dropped.length > 0
          ? dropped.join("\n")
          : null,
    failures,
    advisories,
  };
}

type Verdict =
  | {
      readonly kind: "clean";
      readonly rendered: Frame;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "fatal";
      readonly message: string;
      readonly warnings: readonly string[];
    };

// The bar drawn under every preset, through a bar of the daemon's own parts
// over the faked session, every render error a failure. Its frame is the one
// a fresh session draws.
async function drawnVerdict(
  world: World,
  gates: Gates,
  snapshot: ConfigSnapshot,
  {
    cwd,
    args,
    settleMs,
    build,
  }: {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly settleMs: number;
    readonly build: RendererBuilder | undefined;
  },
): Promise<Verdict> {
  // [LAW:effects-at-boundaries] One instant for every pass's fixture, so the
  // passes differ only in the preset they render.
  const at = instantOf(new Date(world.clock.now()));
  const { home } = world.host;
  const { passes, dropped } = passesOf(snapshot, home);
  // Each pass's request, as its client sends it, through the checkpoint the
  // daemon's requests cross. [LAW:one-source-of-truth] `check` runs in the
  // session's own shell, so its process environment is the session's.
  const requests = passes.map((pass) => {
    const checked = checkRenderRequest(
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData: checkHook(at, pass.session, cwd),
        args: ["cc-candybar", ...args],
        cwd,
        encoding: "frame",
        env: plainEnvironment(world.host.env),
        termCols: columnsReserving(CHECK_WIDTH),
        ...CHECK_HINTS,
      },
      { firstSightOfUnknownHookField: () => false },
      () => {},
      home,
    );
    if (!checked.ok)
      throw new Error(
        `check's own request was refused: ${checked.problems.join("; ")}`,
      );
    return { pass, ...checked };
  });
  const first = requests[0];
  if (first === undefined) throw new Error("check drew no pass");
  const bar = localBar({
    world,
    gates,
    // [LAW:single-enforcer] check draws `run` links as the daemon does, and
    // signs them as the preview it is: it opens no key file.
    linkSigner: previewSigner(),
    stateDir: stateDir(world.host),
    home: CHECK_HOME,
    locate: checkLocate,
    origin: first.req.requested,
    snapshot,
    stored: {
      ...EMPTY_STORED_STATE,
      sessions: Object.fromEntries(
        passes.flatMap((p) =>
          p.pick === null ? [] : [[p.session, { preset: p.pick }]],
        ),
      ),
    },
    owners: (sourceRuns, log) => checkOwners(at, sourceRuns, log),
    daemon: commandDaemonFacts,
    build,
  });
  const read: PassReading[] = [];
  try {
    // [LAW:no-ambient-temporal-coupling] One deadline every pass's wait
    // shares, from the first request on.
    const waitEndsAt = world.clock.monotonic() + settleMs;
    // The passes run one after another, as one session's requests would.
    for (const { pass, req, environment } of requests)
      read.push(
        readPass(pass, await bar.draw(req, environment, waitEndsAt), settleMs),
      );
  } finally {
    // A one-shot check must not leak the timers, watches and children the
    // config declared past the verdict.
    await bar.close();
  }
  const [primary] = read;
  if (primary === undefined) throw new Error("check drew no pass");
  // [LAW:one-source-of-truth] One line per (what, why) — the line's text —
  // however many passes reach it, for failures and advisories alike: an
  // unconditional error fires in every pass, and reporting it once per
  // preset would count one bug N times. A line the fresh session's own pass
  // shows is reported bare — that is the bar a session opens on; any other is
  // tagged with the presets that reach it, so the reader knows which switch
  // exposes it.
  const reported = (linesOf: (r: PassReading) => readonly string[]) => {
    const found = new Map<string, string[]>();
    for (const r of read)
      for (const line of linesOf(r))
        found.set(line, [
          ...(found.get(line) ?? []),
          ...(r === primary ? [] : [`preset "${r.pass.preset}"`]),
        ]);
    return [...found].map(([line, presets]) =>
      linesOf(primary).includes(line)
        ? line
        : `${line} (under ${presets.join("; ")})`,
    );
  };
  const warnings = reported((r) => r.advisories);
  if (primary.fatal !== null)
    return { kind: "fatal", message: primary.fatal, warnings };
  const errors = [
    ...bar.errors(),
    ...reported((r) => [...(r.fatal === null ? [] : [r.fatal]), ...r.failures]),
  ];
  const failures = [
    ...(dropped > 0
      ? [
          `${dropped} plugin${dropped === 1 ? "" : "s"} did not load (named in the warnings)`,
        ]
      : []),
    ...(errors.length > 0
      ? [
          `config renders with ${errors.length} render error${
            errors.length === 1 ? "" : "s"
          } (the daemon would show them on the bar):\n` +
            errors.map((m) => `  ${m}`).join("\n"),
        ]
      : []),
  ];
  return failures.length > 0 || primary.frame === null
    ? { kind: "fatal", message: failures.join("\n"), warnings }
    : { kind: "clean", rendered: primary.frame, warnings };
}

const EXIT_CLEAN = 0;
const EXIT_FATAL = 1;
const EXIT_USAGE = 2;

// [LAW:dataflow-not-control-flow] The outcome → (streams, exit-code) mapping is
// DATA: a total fold over CheckOutcome returning one plan (src/cli-plan.ts),
// which the entry delivers. Verdict on stdout, every diagnostic (warnings
// included) on stderr — so `check` in a pipeline yields a parseable verdict
// while a human still sees the advisories.

function warningLines(warnings: readonly string[]): string {
  return warnings.map((w) => `warning: ${w}\n`).join("");
}

// `--render` (brandon-check-m2a): the bar beneath the verdict line, for an
// author who cannot look at a live one. [LAW:one-source-of-truth] It is
// `o.rendered` — the very frame the verdict's fresh-session pass reached —
// so the bar an author reads and the bar `check` blessed cannot differ; re-rendering here
// (at a terminal width, say) would be two clocks, and the audience this exists
// for reads a pipe, which has no width at all. The flag adds a VALUE to one
// stream rather than selecting a code path: the plan's two streams are
// unconditional either way, and the arms that never rendered have no bar to
// print because `rendered` lives on the clean arm alone
// [LAW:types-are-the-program].
export function checkPlan(o: CheckOutcome, render = false): CliPlan {
  switch (o.kind) {
    case "clean": {
      const where = chainName(o.layers.map((l) => l.path));
      const count =
        o.warnings.length > 0
          ? ` (${o.warnings.length} warning${o.warnings.length === 1 ? "" : "s"})`
          : "";
      return {
        stdout:
          `✓ ${where}: config OK${count}\n` +
          (render ? `${ansiOf(o.rendered)}\n` : ""),
        stderr: warningLines(o.warnings),
        code: EXIT_CLEAN,
      };
    }
    case "fatal":
      return {
        stdout: "",
        stderr:
          warningLines(o.warnings) +
          `✗ ${chainName(
            o.layers.map((l) => l.path),
            "<default>",
          )}\n${o.message}\n`,
        code: EXIT_FATAL,
      };
    case "unreadable":
      return {
        stdout: "",
        stderr: `check: cannot read ${o.path}: ${o.message}\n`,
        code: EXIT_USAGE,
      };
  }
}

const RENDER_FLAG = "--render";
const USAGE = `Usage: cc-candybar check [${RENDER_FLAG}] [config-file | --config-only config-file]\n`;

// [LAW:parse-dont-validate] argv crosses one checkpoint and becomes a request
// the rest of the command reads by field; nothing inland re-reads `args`.
// Inspecting them inline and exiting from the middle of the command would
// put the usage contract out of reach of everything but a spawned process — the same reason `checkPlan` is a value: a misspelled
// option is now observable exactly like every other outcome.
type CheckArgs =
  | {
      readonly kind: "run";
      readonly target: string | undefined;
      readonly flag: ConfigFlag;
      readonly render: boolean;
    }
  | { readonly kind: "usage"; readonly message: string };

function parseCheckArgs(args: readonly string[]): CheckArgs {
  const options = args.filter((a) => a.startsWith("--"));
  const paths = args.filter((a) => !a.startsWith("--"));
  // [LAW:no-silent-failure] An unrecognised option is named, never taken for a
  // path — read as one it would be reported as an unreadable file, a
  // diagnostic about the wrong thing entirely.
  const only = options.includes("--config-only");
  const unknown = options.filter(
    (o) => o !== RENDER_FLAG && o !== "--config-only",
  );
  if (unknown.length > 0) {
    return {
      kind: "usage",
      message: `check: unknown option ${unknown.join(" ")}\n${USAGE}`,
    };
  }
  // [LAW:single-enforcer] Arity only. What the path means — including that an
  // empty one, a statusline's `--config "$CFG"` with CFG unset, resolves like
  // no argument — is `cliConfigTarget`'s to say in `checkCommandPlan`, the one
  // reading `doctor` runs under and the bar renders under.
  if (paths.length > 1) {
    return {
      kind: "usage",
      message: `check: expected at most one path\n${USAGE}`,
    };
  }
  if (only && !paths[0]) {
    return {
      kind: "usage",
      message: "check: --config-only needs a path\n" + USAGE,
    };
  }
  return {
    kind: "run",
    target: paths[0],
    flag: only ? "config-only" : "config",
    render: options.includes(RENDER_FLAG),
  };
}

// `cc-candybar check [--render] [path]` — the argv binding, and the one place
// the command touches the process: two unconditional writes and the exit code
// its plan carries.
export async function checkCommandPlan(
  args: readonly string[],
  world: World,
): Promise<CliPlan> {
  const parsed = parseCheckArgs(args);
  const cwd = process.cwd();
  return parsed.kind === "usage"
    ? { stdout: "", stderr: parsed.message, code: EXIT_USAGE }
    : checkPlan(
        // [LAW:one-source-of-truth] The target the doctor would check under
        // the same argument, already absolute — `checkConfig`'s own
        // resolution, the seam for its direct callers, passes it through.
        await checkConfig(
          world,
          createGates(),
          cliConfigTarget(parsed.target, world.host, cwd, parsed.flag),
          cwd,
        ),
        parsed.render,
      );
}
