// The renderer's link to the host: in this process, or in a process of its
// own that a supervisor starts and restarts. The host holds one `Renderer`
// either way, and no part outside the link knows which, nor whether a
// renderer restarted.
//
// [LAW:single-enforcer] The supervisor is the one owner of a renderer
// process's life: it starts one as its daemon arms, restarts one that ended
// after a backoff, ends one whose loop stops answering, and says each end once.
// [LAW:no-ambient-temporal-coupling] Its life is a state, `idle → starting →
// live → down → starting …`, and every input asks the state where it goes.

import { backedOffMs } from "../utils/period.js";
import { streamedToFile } from "./streamed-file.js";
import type { RendererRecording } from "./renderer-recording.js";
import type { Timekeeper } from "../time.js";
import type { Launcher, Channel } from "../proc/launcher.js";
import { whyFailed } from "../proc/launcher.js";
import { writeLogLines, type DaemonLogger } from "../utils/logger.js";
import { isPlainObject } from "../config/loader/validate-core.js";
import { eventLine, type Field } from "../utils/logfmt.js";
import { instantAt } from "../utils/instant.js";
import type { HeldEvent } from "../utils/event-hold.js";
import {
  isCommand,
  sessionOfEvent,
  type EffectId,
  type EventInput,
  type RendererBoot,
  type Timed,
  type TimedRenderer,
  type RendererOutput,
} from "../renderer-interface/interface.js";
import type { OwnUsage } from "./foundations/memory-limit.js";
import {
  lineSplitter,
  rendererDiagnosticsFrom,
  rendererOverLines,
  rendererWireVersionProblem,
  RENDERER_WIRE_VERSION,
  type HostLine,
  type RendererLine,
  type RendererOverLines,
} from "../renderer-interface/wire.js";
import {
  DaemonClosing,
  RendererDown,
  failureOf,
  failureKindOf,
} from "./foundations/verb-error.js";
import type { RendererName } from "./foundations/renderer-name.js";

// What the host holds of its renderer, whichever link it runs over.
export interface RendererLink {
  readonly renderer: TimedRenderer;
  // The daemon serves: in process, the renderer is built now, from the stored
  // state the host holds; a process is built at each spawn.
  serve(): void;
  // Starts the renderer's process: nothing in process.
  arm(): void;
  // The owner invokes this between turns. The fresh worker sends its usual
  // start before it takes another session input.
  restart(): Promise<void>;
  // [LAW:types-are-the-program] The transition stops restarts and says
  // whether this link retains a live renderer for the host's drain.
  beginClose(): "closing" | "closed";
  // Ends the renderer's process, after the daemon's close has run the
  // renderer's own steps of it.
  close(): Promise<void>;
  // The renderer's own process as the memory backstop and the stats see it.
  process(): RendererProcessState;
}

// [LAW:types-are-the-program] Where a renderer's memory is: in the host's
// process, charged as the host's; in no process, and why; or in a process
// spawned for it, which the backstop charges from its spawn.
export type RendererProcessState =
  | { readonly kind: "in-host" }
  | { readonly kind: "not-running"; readonly why: string }
  | { readonly kind: "spawned"; readonly process: RendererProcess };

export interface RendererProcess {
  readonly name: RendererName;
  // Which of the renderer's spawns this is: a pid the OS hands a later spawn
  // names another process.
  readonly generation: number;
  readonly pid: number;
  readonly usage: OwnUsage;
  // A breach's heap snapshot of this process once it is live, never of a
  // renderer started since: one starting or ended writes none and says so.
  heapSnapshot(file: string): Promise<void>;
  // A breach's end of this process, said as any end is and followed by a
  // fresh start. [LAW:no-ambient-temporal-coupling] Only while it is the
  // starting or live renderer: one the close is draining finishes its close
  // steps, and one being replaced is already ending.
  end(why: string): void;
}

// Where a daemon's renderer runs, in two steps of the daemon's build: the
// port is handed the bound entry and its boot data as the daemon's build
// begins, and its `start` the host's reaches once the host's parts exist.
export type RendererPort = (prepared: {
  // The renderer's name, which every line its link says carries.
  readonly name: RendererName;
  // Read for each spawn so a replacement receives the current profile.
  readonly boot: () => RendererBoot;
  readonly recording?: () => RendererRecording | undefined;
  // The executable entry and the Node invocation which loads it.
  readonly entry: string;
  readonly node: readonly string[];
}) => { start(own: LinkOwner): RendererLink };

// The renderer in a process of its own, built there from its boot.
export function processPort(
  run: Pick<ProcessOwner, "launcher" | "cwd" | "heapCapMb">,
): RendererPort {
  return ({ name, boot, node, entry, recording }) => ({
    start: (own) =>
      processRenderer({ ...own, ...run, name, node, entry, boot, recording }),
  });
}

// What the daemon hands a link as it starts it: the host's complete start, which delivers each live session's `context` and who
// watches each session through the host's one path to the renderer,
// resolving once its turn has answered; and who holds each end as an event,
// which every session's world state carries for the bar's ⚠.
// [LAW:no-ambient-temporal-coupling] The start is the host's state as one
// renderer spawns, so it is sent ahead of every input after it: each of those
// follows it as a change, and none can repeat or contradict it.
export interface LinkOwner {
  readonly log: DaemonLogger;
  readonly clock: Timekeeper;
  readonly start: () => Promise<void>;
  readonly ended: (event: HeldEvent) => void;
}

// What a process link is built from besides: the launcher whose lifetime is
// the process's, so the daemon's close aborting its own launches does not end
// the renderer before the renderer's own close steps; how to run it; and the
// boot it sends.
export interface ProcessOwner extends LinkOwner {
  readonly launcher: Pick<Launcher, "launchChannel">;
  // The node that runs the host, with its flags.
  readonly node: readonly string[];
  // The renderer's bound entry, or the source under a test's loader.
  readonly entry: string;
  // Where the renderer runs: the state directory, never the detached
  // daemon's inherited cwd.
  readonly cwd: string;
  readonly heapCapMb: number;
  readonly boot: () => RendererBoot;
  readonly recording?: () => RendererRecording | undefined;
  readonly name: RendererName;
}

// How often the supervisor pings a live renderer, and how long one may go
// unanswered: well above the longest synchronous work a renderer does (a
// config's compile, a reload of every entry), so only a loop that has stopped
// misses it. A boot is judged by the same allowance, from its spawn.
export const PING_PERIOD_MS = 10_000;
export const HUNG_AFTER_MS = 60_000;
// A renderer that ended by itself after serving this long proved itself. Any
// other end (young, before its boot answered, or one the host decided) is one
// more in a row, and each next start in a row waits twice as long, from the
// first wait to the last.
export const YOUNG_MS = 60_000;
export const BACKOFF_FIRST_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
// How long a renderer has to end once its stdin closes, inside the shutdown's
// own backstop, before it is signalled.
export const CLOSE_GRACE_MS = 250;

// The node flags a renderer runs under: the host's own (a test's loader among
// them), with the renderer's own heap cap and no inspector, which would take
// the host's port.
export function rendererNodeArgs(
  hostArgs: readonly string[],
  heapCapMb: number,
): string[] {
  return [
    ...hostArgs.filter(
      (arg) =>
        !arg.startsWith("--max-old-space-size") && !arg.startsWith("--inspect"),
    ),
    `--max-old-space-size=${heapCapMb}`,
  ];
}

// The wait before the next start, from how many renderers in a row did not
// prove themselves: none after one that did.
// [LAW:one-source-of-truth] The one exponential backoff.
export function backoffMs(failed: number): number {
  return backedOffMs(
    { okMs: 0, failedMs: BACKOFF_FIRST_MS },
    failed,
    BACKOFF_MAX_MS,
  );
}

// One renderer process, from its spawn to its end.
interface Link {
  readonly generation: number;
  readonly channel: Channel;
  // What the renderer says, and what is owed it.
  readonly lines: RendererOverLines;
  readonly kill: AbortController;
  readonly spawnedAt: number;
  // Admission belongs to the connection and survives close while its
  // remaining stdout is drained. It makes no lifecycle decision.
  compatible: boolean;
  // Why the host ended this generation, which its exit reports whatever the
  // phase has become by then. Set once, by the end's one transition.
  endReason: string | null;
  // Whether its boot answered, so it served.
  served: boolean;
  // Each host receipt is meaningful only to the worker that issued it.
  readonly receipts: Map<EffectId, EffectId>;
  // Boot data is held only until the recording's construction result arrives.
  recordingBoot?: RendererBoot;
  readonly recording?: RendererRecording;
  usage: OwnUsage;
  // When the ping owed an answer went out.
  pingSentAt: number | null;
  // Its stop, once one is begun: the first stop owns it.
  stopping: Promise<void> | null;
  // Its exit, once said: the end it was, in the log and on the bar.
  readonly reported: Promise<void>;
}

// A generation the host has ended, with the reason it did.
type EndedLink = Link & { readonly endReason: string };

type Phase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "replacing";
      readonly link: Link;
      readonly ended: Promise<void>;
    }
  | {
      readonly kind: "starting";
      readonly link: Link;
      // [LAW:no-ambient-temporal-coupling] The transition out of boot gives
      // each queued input its link or the reason it never got one.
      readonly queued: Array<
        (result: Link | DaemonClosing | RendererDown) => void
      >;
    }
  | { readonly kind: "live"; readonly link: Link }
  // The host has ended this generation: a failed boot or restoration, no
  // answer to its pings, or its memory. It serves no input and is judged no
  // more, and its exit starts the next.
  | { readonly kind: "ending"; readonly link: EndedLink }
  // The daemon's close has begun: the live renderer takes its steps, and its
  // end starts no other.
  | { readonly kind: "closing"; readonly link: Link }
  | {
      readonly kind: "down";
      readonly why: string;
      readonly cancelRetry: () => void;
    }
  // The renderer the close stopped is ending, which the close awaits.
  | { readonly kind: "closed"; readonly ended: Promise<unknown> };

// Where the close's beginning leaves a renderer: one live takes the close's
// steps, and any other is closed.
type Begun = Extract<Phase, { kind: "closing" | "closed" }>;

export function processRenderer(own: ProcessOwner): RendererLink {
  const { clock, log, name } = own;
  let phase: Phase = { kind: "idle" };
  let generation = 0;
  // Renderers in a row that did not prove themselves.
  let failed = 0;
  // Inputs refused while none was live, said once the next one is.
  let refused = 0;
  // Host receipts stay distinct across generations, even if a renderer starts
  // numbering its effects and feed presentations at one again.
  let lastReceipt = 0;

  const current = (): Link | null =>
    phase.kind === "starting" ||
    phase.kind === "live" ||
    phase.kind === "closing"
      ? phase.link
      : null;
  const unavailable = (
    at: Extract<
      Phase,
      { kind: "idle" | "down" | "closed" | "replacing" | "ending" }
    >,
  ): DaemonClosing | RendererDown => {
    switch (at.kind) {
      case "closed":
        return new DaemonClosing(`renderer ${name} input`);
      case "down":
        return new RendererDown(`renderer ${name} is down: ${at.why}`);
      case "idle":
        return new RendererDown(`renderer ${name} has not started`);
      case "replacing":
        return new RendererDown(
          `renderer ${name} is starting a fresh generation`,
        );
      case "ending":
        return new RendererDown(
          `renderer ${name} is ending: ${at.link.endReason}`,
        );
    }
  };

  const write = (channel: Channel, line: HostLine): void =>
    channel.write(`${JSON.stringify(line)}\n`);

  const restore = async (link: Link): Promise<void> => {
    try {
      await own.start();
    } catch (thrown) {
      const failure = failureOf(thrown);
      if (failure.kind === "closing") return;
      log(
        "error",
        `renderer ${name}[${link.generation}] start failed: ${failure.detail}`,
      );
      // The usual exit path supplies the retry and backoff.
      endWith(link, `failed to start: ${failure.message}`);
    }
  };

  const spawn = (): void => {
    const generationOf = ++generation;
    const boot = own.boot();
    const kill = new AbortController();
    // A channel's output arrives on a later turn, so the link its lines reach
    // is set before the child can have said anything.
    let heardBy: (text: string) => void = () => {};
    const stdout = lineSplitter((text) => heardBy(text));
    const stderr = lineSplitter((text) =>
      log("warn", `renderer ${name}[${generationOf}]: ${text}`),
    );
    const channel = own.launcher.launchChannel({
      bin: own.node[0] as string,
      args: [
        ...rendererNodeArgs(own.node.slice(1), own.heapCapMb),
        own.entry,
        "renderer",
      ],
      cwd: own.cwd,
      category: "renderer",
      signal: kill.signal,
      heard: { stdout: stdout.push, stderr: stderr.push },
    });
    const recording = own.recording?.();
    // [LAW:single-enforcer] The one report of this generation's exit, which a
    // restart that finds it ending waits for.
    const reported = channel.ended.then((result) => {
      stdout.end();
      stderr.end();
      ended(link, link.endReason ?? (result.ok ? "exited" : whyFailed(result)));
    });
    const link: Link = {
      recording,
      recordingBoot: recording?.snapshot(boot),
      generation: generationOf,
      channel,
      kill,
      spawnedAt: clock.monotonic(),
      compatible: false,
      endReason: null,
      served: false,
      receipts: new Map(),
      usage: { kind: "unread", why: "no ping has answered yet" },
      pingSentAt: null,
      stopping: null,
      reported,
      lines: rendererOverLines({
        send: (line) => write(channel, line),
        fault: (message) => {
          recording?.fail(
            "renderer wire output could not be decoded faithfully",
          );
          log("error", `renderer ${name}[${generationOf}]: ${message}`);
        },
      }),
    };
    phase = { kind: "starting", link, queued: [] };
    write(channel, {
      kind: "boot",
      wireVersion: RENDERER_WIRE_VERSION,
      boot,
    });
    // [LAW:no-ambient-temporal-coupling] The start heads the queue: it heads
    // the host's mailbox (src/daemon/renderer-host.ts), so every input after
    // this is queued behind the state it changes.
    heardBy = (text) => heard(link, text);
    clock.detach(`renderer ${name} restore`, () => restore(link));
    clock.detach(`renderer ${name} end`, () => reported);
  };

  const heard = (link: Link, text: string): void => {
    // An ended generation's answers are its interrupted inputs' to report.
    if (link.endReason !== null) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      // [LAW:no-silent-failure] A line that is not the wire's is said.
      log("warn", `renderer ${name}[${link.generation}]: ${text}`);
      return;
    }
    if (!isPlainObject(raw)) {
      log(
        "warn",
        `renderer ${name}[${link.generation}] sent a non-object line`,
      );
      return;
    }
    if (phase.kind === "starting" && phase.link === link) {
      // The peer may speak an older protocol. Only the boot answer is
      // considered before the worker attests to this connection's version.
      if (raw.kind === "started" || raw.kind === "refused")
        acceptBoot(phase, raw);
      return;
    }
    if (link.compatible && raw.kind !== "started" && raw.kind !== "refused")
      link.lines.heard(raw as RendererLine);
  };

  const acceptBoot = (
    starting: Extract<Phase, { kind: "starting" }>,
    raw: Readonly<Record<string, unknown>>,
  ): void => {
    const { link, queued } = starting;
    let refusal: { readonly message: string; readonly detail: string } | null =
      null;
    if (raw.kind === "started") {
      // [LAW:parse-dont-validate] Inspect only the version until this peer
      // attests to the private protocol. Other versions' fields are opaque.
      const mismatch = rendererWireVersionProblem("renderer", raw.wireVersion);
      if (mismatch !== null) {
        refusedBoot(link, mismatch);
        return;
      }
      if (
        typeof raw.pid !== "number" ||
        !Number.isSafeInteger(raw.pid) ||
        raw.pid <= 0
      ) {
        refusedBoot(link, "renderer boot has an invalid pid");
        return;
      }
    } else {
      const failure = raw.failure;
      // A refusal can be from a different protocol version. Its reason is
      // the stable part of the envelope, including across version mismatch.
      if (
        !isPlainObject(failure) ||
        typeof failure.message !== "string" ||
        typeof failure.detail !== "string"
      ) {
        refusedBoot(link, "renderer boot has an invalid refusal");
        return;
      }
      refusal = { message: failure.message, detail: failure.detail };
    }
    const diagnostics = rendererDiagnosticsFrom(
      raw.wireVersion === RENDERER_WIRE_VERSION ? raw.diagnostics : undefined,
      () => {
        link.recording?.fail(
          "renderer construction diagnostics could not be decoded faithfully",
        );
        log(
          "warn",
          `renderer ${name}[${link.generation}] boot has invalid diagnostics`,
        );
      },
    );
    if (diagnostics !== undefined) writeLogLines(log, diagnostics);
    if (link.recordingBoot !== undefined) {
      const input = link.recordingBoot;
      delete link.recordingBoot;
      // The live admission above checks versions and diagnostic shapes.
      // A refused construction still has a replayable semantic answer.
      if (raw.wireVersion !== RENDERER_WIRE_VERSION)
        link.recording?.fail(
          "renderer wire version differs from the recording format",
        );
      else if (raw.kind === "started")
        link.recording?.constructed(input, {
          kind: "built",
          ...(diagnostics && { diagnostics }),
        });
      else {
        const kind = isPlainObject(raw.failure)
          ? failureKindOf(raw.failure.kind)
          : undefined;
        if (kind !== undefined && refusal !== null)
          link.recording?.constructed(input, {
            kind: "refused",
            failure: { kind, ...refusal },
            ...(diagnostics && { diagnostics }),
          });
        else link.recording?.fail("invalid renderer construction failure");
      }
    }
    if (refusal !== null) {
      refusedBoot(link, refusal.message, refusal.detail);
      return;
    }
    link.compatible = true;
    link.served = true;
    phase = { kind: "live", link };
    // [LAW:nothing-unseen] The start, with what was refused while none ran.
    log(
      "info",
      `renderer ${name}[${link.generation}] started pid=${link.channel.pid ?? "-"} refused-while-down=${refused}`,
    );
    refused = 0;
    for (const send of queued) send(link);
    // Its memory is read at once, not a period after its boot.
    ping(link);
  };

  // [LAW:single-enforcer] Every end the supervisor decides, whatever its
  // reason: the generation keeps the reason its exit reports, and the first
  // reason owns it. It ends one starting, live or taking the close's steps
  // (one that stopped answering cannot take them). One starting or live moves
  // to ending, and what waited for its boot fails; one the close waits on
  // stays the close's, whose end starts nothing. Every end stops its process
  // as the close does, so one that would not exit by itself is signalled
  // after the grace. A reason the end refuses is said: a second one, or an
  // end of a renderer the phase has moved past.
  const endWith = (link: Link, why: string): void => {
    const at = phase;
    const mine =
      (at.kind === "starting" || at.kind === "live" || at.kind === "closing") &&
      at.link === link;
    if (!mine || link.endReason !== null) {
      notEnded(link, why, at.kind);
      return;
    }
    const ending: EndedLink = Object.assign(link, { endReason: why });
    if (at.kind !== "closing") {
      phase = { kind: "ending", link: ending };
      if (at.kind === "starting")
        for (const send of at.queued) send(unavailable(phase));
    }
    clock.detach(`renderer ${name} end`, () => stopGracefully(link, why));
  };

  // [LAW:no-silent-failure] An end refused is said, with what holds it.
  const notEnded = (link: Link, why: string, at: Phase["kind"]): void =>
    log(
      "info",
      `renderer ${name}[${link.generation}] was not ended for ${why}: ${link.endReason !== null ? `it is already ending: ${link.endReason}` : `it is ${at}`}`,
    );

  // [LAW:no-silent-failure] Its end says why, on the ⚠ as in the log. The
  // stack is the log's alone.
  const refusedBoot = (link: Link, reason: string, detail = reason): void => {
    log(
      "error",
      `renderer ${name}[${link.generation}] refused its boot: ${detail}`,
    );
    endWith(link, `refused its boot: ${reason}`);
  };

  const ended = (link: Link, how: string): void => {
    const interrupted = link.lines.ended(
      new RendererDown(`renderer ${name} ${how}`),
    );
    for (const { n, input } of interrupted) {
      const fields: Field[] = [
        ["renderer", name],
        ["generation", String(link.generation)],
        ["wire", String(n)],
      ];
      const session = sessionOfEvent(input.event);
      fields.push(["input", input.event.kind]);
      if (session !== null) fields.push(["sid", session]);
      if (input.event.kind === "request")
        fields.push(["request", String(input.event.id)]);
      fields.push(["error", how]);
      log("warn", eventLine("renderer input interrupted", fields));
    }
    // [LAW:no-ambient-temporal-coupling] An end once the close has begun
    // starts nothing: a fresh renderer holds nothing to flush, and the close's
    // remaining steps would wait on its boot.
    // [LAW:nothing-unseen] Said all the same, and as a warning unless the
    // close had ended it and it exited: one the close had not yet ended went
    // before its close steps ran, and one that did not exit went mid-flush.
    if (phase.kind === "replacing" && phase.link === link) {
      log(
        "info",
        `renderer ${name}[${link.generation}] ended for a requested recording`,
      );
      return;
    }
    if (phase.kind !== "closing" && phase.kind !== "closed")
      link.recording?.interrupted();
    const level =
      phase.kind === "closing" || how !== "exited" ? "warn" : "info";
    if (phase.kind === "closing")
      phase = { kind: "closed", ended: link.channel.ended };
    if (phase.kind === "closed") {
      log(
        level,
        `renderer ${name}[${link.generation}] ${how} in the daemon's close`,
      );
      return;
    }
    const queued = phase.kind === "starting" ? phase.queued : [];
    const lived = clock.monotonic() - link.spawnedAt;
    // [LAW:no-ambient-temporal-coupling] An end the host decided proves the
    // renderer unwell however long it served, so a renderer that breaches each
    // time it rebuilds waits longer before each start.
    const proved = link.endReason === null && link.served && lived >= YOUNG_MS;
    failed = proved ? 0 : failed + 1;
    const delay = backoffMs(failed);
    const why = `renderer ${name}[${link.generation}] ${how}`;
    phase = {
      kind: "down",
      why: how,
      cancelRetry: clock.after(`renderer ${name} respawn`, delay, () => {
        if (phase.kind === "down") spawn();
      }),
    };
    // What waited for a start that never came fails as no renderer's.
    for (const send of queued) send(unavailable(phase));
    const event: HeldEvent = {
      text: `${why}; it restarts, and unsaved state (open menus, armed confirms) is lost`,
      at: instantAt(clock),
      answered: false,
    };
    // [LAW:single-enforcer] The one line for an end, however many inputs
    // then find no renderer.
    log(
      "warn",
      `${why} after ${Math.round(lived / 1000)} s; next start in ${Math.round(delay / 1000)} s`,
    );
    own.ended(event);
  };

  // [LAW:single-enforcer] The one liveness check: a ping the renderer's loop
  // answers outside its turns, judged as the next goes out.
  const pinged = (): void => {
    const link = current();
    if (link === null) return;
    const now = clock.monotonic();
    const owedSince =
      phase.kind === "starting" ? link.spawnedAt : link.pingSentAt;
    if (owedSince !== null && now - owedSince > HUNG_AFTER_MS) {
      // One that stopped answering cannot take the close's steps either.
      endWith(link, `stopped answering for ${HUNG_AFTER_MS / 1000} s`);
      return;
    }
    // A renderer the close still waits on is judged as a live one is.
    if (phase.kind !== "starting" && link.pingSentAt === null) ping(link);
  };
  const ping = (link: Link): void => {
    link.pingSentAt = clock.monotonic();
    link.lines.ping().then(
      (sizes) => {
        link.usage = { kind: "read", sizes };
        link.pingSentAt = null;
      },
      (thrown: unknown) => {
        // A gone renderer's end reports its own reason.
        if (current() !== link) return;
        log(
          "warn",
          `renderer ${name}[${link.generation}] ping failed: ${failureOf(thrown).detail}`,
        );
      },
    );
  };
  let stopPings: () => void = () => {};

  // [LAW:single-enforcer] How a renderer's process is stopped, by the close,
  // a replacement or an end: its stdin closes, and one that has not ended
  // after the grace is signalled. A process has one stop, the first one
  // begun, which a later one awaits.
  const stopGracefully = (link: Link, why: string): Promise<void> =>
    (link.stopping ??= (async () => {
      link.channel.end();
      const grace = clock.after(
        `renderer ${name} close grace`,
        CLOSE_GRACE_MS,
        () => link.kill.abort(new Error(why)),
      );
      await link.channel.ended;
      grace();
    })());
  // A recording control's fresh generation: the renderer there now stops,
  // and one starts in its place.
  const restart = async (): Promise<void> => {
    switch (phase.kind) {
      case "idle":
        return; // arm will start the first generation.
      case "down":
        phase.cancelRetry();
        spawn();
        return;
      case "starting":
        // A start that still holds the mailbox completes before a recording
        // control slot. A retry can have started in the meantime.
        for (const send of phase.queued.splice(0))
          send(new RendererDown(`renderer ${name} is being replaced`));
        break;
      case "live":
        break;
      // [LAW:single-enforcer] An end the host gave keeps its report and its
      // count toward the backoff: the recording starts once that end is
      // said, as from down.
      case "ending":
        await phase.link.reported;
        return restart();
      default:
        throw new DaemonClosing(`renderer ${name} replacement`);
    }
    const link = phase.link;
    const retiring = {
      kind: "replacing",
      link,
      ended: stopGracefully(link, "it is being replaced"),
    } as const;
    phase = retiring;
    await retiring.ended;
    if (phase !== retiring)
      throw new DaemonClosing(`renderer ${name} replacement`);
    spawn();
  };

  // [LAW:no-ambient-temporal-coupling] The close has begun, whichever phase it
  // finds: the live renderer stays to take the close's steps, and nothing else
  // runs or starts.
  const beginClose = (): Begun => {
    switch (phase.kind) {
      case "replacing":
        return (phase = { kind: "closed", ended: phase.ended });
      // Already ended by the host: the close awaits its exit.
      case "ending":
        return (phase = { kind: "closed", ended: phase.link.channel.ended });
      case "live":
        return (phase = { kind: "closing", link: phase.link });
      // A boot holds nothing to flush, and the close's steps would wait on it:
      // it ends now, beside them, and what waited for it is cancelled.
      case "starting": {
        const { link, queued } = phase;
        const begun = {
          kind: "closed",
          ended: stopGracefully(link, "the daemon closed"),
        } as const;
        phase = begun;
        for (const send of queued) send(unavailable(begun));
        return begun;
      }
      case "down":
        phase.cancelRetry();
        return (phase = { kind: "closed", ended: Promise.resolve() });
      case "idle":
        return (phase = { kind: "closed", ended: Promise.resolve() });
      case "closing":
      case "closed":
        return phase;
    }
  };

  // [LAW:single-enforcer] Inputs refused while down are counted and said
  // with the next start. Closing the daemon cancels the wait.
  const refusal = (why: DaemonClosing | RendererDown): Error => {
    if (why instanceof RendererDown) refused++;
    return why;
  };
  // An input goes to the live renderer, waits for the one starting, or fails
  // as no renderer's.
  const sent = <O>(answer: (link: Link) => Promise<O>): Promise<O> => {
    if (phase.kind === "live" || phase.kind === "closing")
      return answer(phase.link);
    if (phase.kind === "starting") {
      const { queued } = phase;
      return new Promise<O>((resolve, reject) =>
        queued.push((result) => {
          if (result instanceof Error) {
            reject(refusal(result));
          } else {
            answer(result).then(resolve, reject);
          }
        }),
      );
    }
    return Promise.reject(refusal(unavailable(phase)));
  };

  // The ids an input names are the renderer's own again; the ids its output
  // names are the host's.
  const answer = (input: EventInput): Promise<Timed<RendererOutput>> =>
    sent(async (link) => {
      const { event: e } = input;
      let toSend: EventInput = input;
      if (e.kind === "effect-done") {
        const effect = link.receipts.get(e.of);
        // [LAW:no-silent-failure] The renderer that owed this one is gone, so
        // there is no one to tell.
        if (effect === undefined)
          throw new RendererDown(
            `renderer ${name}: effect ${e.of} was returned by a renderer that has ended`,
          );
        link.receipts.delete(e.of);
        toSend = { ...input, event: { ...e, of: effect } };
      }
      const output = link.recording?.active
        ? await link.recording.turn(toSend, link.lines.renderer.answer)
        : await link.lines.renderer.answer(toSend);
      // Inspection and teardown have no presentation or action to settle.
      // Leave any malformed fields for the host to report.
      if (
        isCommand(e) ||
        (output.effects.length === 0 && output.frames.length === 0)
      )
        return output;
      // [LAW:single-enforcer] Effects and feed frames share one receipt
      // namespace. Either can be returned by a turn that subsequently threw.
      const receiptFor = (local: EffectId): EffectId => {
        const host = ++lastReceipt as EffectId;
        link.receipts.set(host, local);
        return host;
      };
      return {
        ...output,
        effects: output.effects.map((effect) => ({
          ...effect,
          id: receiptFor(effect.id),
        })),
        frames:
          output.frames.length === 0
            ? output.frames
            : output.frames.map((pushed) => {
                const { frame } = pushed;
                return frame.kind === "drawn"
                  ? {
                      ...pushed,
                      frame: { ...frame, receipt: receiptFor(frame.receipt) },
                    }
                  : pushed;
              }),
      };
    });
  // [LAW:types-are-the-program] A spawned renderer as the host charges it:
  // its pid from its spawn, its sizes from its pings. An end the phase has
  // moved past by the time it is asked for is said by the end itself.
  const spawnedState = (link: Link): RendererProcessState => {
    const pid = link.channel.pid;
    if (pid === null) return { kind: "not-running", why: "it has no pid" };
    return {
      kind: "spawned",
      process: {
        name,
        generation: link.generation,
        pid,
        usage: link.usage,
        heapSnapshot: (file) =>
          phase.kind === "live" && phase.link === link
            ? streamedToFile(file, (write) => link.lines.heapSnapshot(write))
            : Promise.reject(
                new Error(
                  `renderer ${name}[${link.generation}] is ${phase.kind}, so its heap was not written`,
                ),
              ),
        // [LAW:no-ambient-temporal-coupling] The host's end is the one end,
        // but for a renderer the close has begun to drain: it finishes its
        // close steps, whatever a reading taken before the close finds of it.
        end: (why) =>
          phase.kind === "closing"
            ? notEnded(link, why, phase.kind)
            : endWith(link, why),
      },
    };
  };
  return {
    renderer: { answer },
    restart,
    serve: () => {},
    arm: () => {
      if (phase.kind !== "idle") return;
      spawn();
      stopPings = clock.every(`renderer ${name} ping`, PING_PERIOD_MS, pinged, {
        unref: true,
      });
    },
    beginClose: () => beginClose().kind,
    close: async () => {
      const begun = beginClose();
      const ended =
        begun.kind === "closing"
          ? stopGracefully(begun.link, "the daemon closed")
          : begun.ended;
      phase = { kind: "closed", ended };
      stopPings();
      await ended;
    },
    process: (): RendererProcessState => {
      switch (phase.kind) {
        case "idle":
          return { kind: "not-running", why: "it has not started" };
        case "replacing":
          return { kind: "not-running", why: "it is being replaced" };
        case "down":
          return { kind: "not-running", why: phase.why };
        case "closed":
          return { kind: "not-running", why: "the daemon closed it" };
        case "closing":
          return { kind: "not-running", why: "the daemon is closing it" };
        case "ending":
          return {
            kind: "not-running",
            why: `it is ending: ${phase.link.endReason}`,
          };
        case "starting":
        case "live":
          return spawnedState(phase.link);
      }
    },
  };
}
