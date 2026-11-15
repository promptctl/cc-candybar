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

import type { Timekeeper } from "../time.js";
import type { Launcher, Channel } from "../proc/launcher.js";
import { whyFailed } from "../proc/launcher.js";
import type { DaemonLogger } from "../utils/logger.js";
import { instantAt } from "../utils/instant.js";
import type { HeldEvent } from "../utils/event-hold.js";
import {
  rendererOf,
  type AdapterInput,
  type AdapterOutput,
  type EffectId,
  type EventInput,
  type Renderer,
  type RendererOutput,
} from "../renderer-interface/interface.js";
import type {
  AdapterToHost,
  StorageHoldId,
  WatchId,
} from "../renderer-interface/adapter.js";
import type { MemorySizes } from "./foundations/memory-limit.js";
import {
  lineSplitter,
  rendererOverLines,
  type HostLine,
  type RendererBoot,
  type RendererLine,
  type RendererOverLines,
} from "../renderer-interface/wire.js";
import type { LoadedMainRenderer } from "../renderer/main.js";
import { RendererDown } from "./foundations/verb-error.js";

// What the host holds of its renderer, whichever link it runs over.
export interface RendererLink {
  readonly renderer: Renderer;
  // Starts the renderer's process: nothing in process, where it started as
  // it was built.
  arm(): void;
  // Ends the renderer's process, after the daemon's close has run the
  // renderer's own steps of it.
  close(): Promise<void>;
  // The renderer's own process from its spawn to its end, booting included:
  // its pid, and its memory as its latest ping read it. Null in process,
  // where the host's charge is the renderer's.
  process(): RendererProcess | null;
}

export interface RendererProcess {
  readonly pid: number;
  readonly usage: MemorySizes | null;
  // A breach's heap snapshot of this process, never of a renderer started
  // since: one that has ended, or has not finished booting, writes none and
  // says so.
  heapSnapshot(file: string): Promise<void>;
}

// Where a daemon's renderer runs, in two steps of the daemon's build: the
// port is handed the renderer's own load and its boot as the daemon's build
// begins, and its `start` the host's reaches once the host's parts exist.
export type RendererPort = (prepared: {
  readonly load: () => LoadedMainRenderer;
  readonly boot: RendererBoot;
  // The node that runs the host, with its flags.
  readonly node: readonly string[];
}) => { start(own: LinkOwner): RendererLink };

// [LAW:one-type-per-behavior] The renderer in this process: what a test's
// daemon and the page run. It loads as the daemon's build begins, so storage
// that cannot be read refuses the build before any owner arms a timer.
export const inProcessPort: RendererPort = ({ load }) => {
  const loaded = load();
  return { start: (own) => inProcessRenderer(loaded, own.reaches) };
};

// The renderer in a process of its own, which loads there, so the host never
// opens the files the renderer is the one writer of.
export function processPort(
  run: Pick<ProcessOwner, "launcher" | "entry" | "cwd" | "heapCapMb">,
): RendererPort {
  return ({ boot, node }) => ({
    start: (own) => processRenderer({ ...own, ...run, node, boot }),
  });
}

function inProcessRenderer(
  loaded: LoadedMainRenderer,
  reaches: AdapterToHost,
): RendererLink {
  const renderer = loaded.start(reaches);
  return {
    renderer,
    arm: () => {},
    close: async () => {},
    process: () => null,
  };
}

// What the daemon hands a link as it starts it: the host's reaches; the
// host's complete start, which delivers each live session's `config` and each
// open feed's `pin` through the host's one path to the renderer, resolving
// once every `config` turn has answered; and who holds each end as an event,
// which every session's world state carries for the bar's ⚠.
// [LAW:no-ambient-temporal-coupling] The start is the host's state as one
// renderer spawns, so it is sent ahead of every input after it: each of those
// follows it as a change, and none can repeat or contradict it.
export interface LinkOwner {
  readonly reaches: AdapterToHost;
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
  // The entry the host's own process runs, which the node flags load: the
  // bundle, or the source under a test's loader.
  readonly entry: string;
  // Where the renderer runs: the state directory, never the detached
  // daemon's inherited cwd.
  readonly cwd: string;
  readonly heapCapMb: number;
  readonly boot: RendererBoot;
}

// How often the supervisor pings a live renderer, and how long one may go
// unanswered: well above the longest synchronous work a renderer does (a
// config's compile, a reload of every entry), so only a loop that has stopped
// misses it. A boot is judged by the same allowance, from its spawn.
export const PING_PERIOD_MS = 10_000;
export const HUNG_AFTER_MS = 60_000;
// A renderer that ended within this of its start ended young: each next one
// in a row waits twice as long, from the first wait to the last.
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

// The wait before the next start, from how many renderers in a row ended
// young: none after one that lived.
export function backoffMs(young: number): number {
  return young === 0
    ? 0
    : Math.min(BACKOFF_FIRST_MS * 2 ** (young - 1), BACKOFF_MAX_MS);
}

// One renderer process, from its spawn to its end.
interface Link {
  readonly generation: number;
  readonly channel: Channel;
  // What the renderer says, and what is owed it.
  readonly lines: RendererOverLines;
  readonly kill: AbortController;
  readonly spawnedAt: number;
  // That the supervisor ended it for not answering.
  hung: boolean;
  // Why it refused its boot, which its end says.
  refusal: string | null;
  readonly held: Held;
  usage: MemorySizes | null;
  // When the ping owed an answer went out.
  pingSentAt: number | null;
}

type Phase =
  | { readonly kind: "idle" }
  | {
      readonly kind: "starting";
      readonly link: Link;
      // Inputs that came while it booted, sent once its start is.
      readonly queued: Array<() => void>;
    }
  | { readonly kind: "live"; readonly link: Link }
  | { readonly kind: "down"; readonly why: string; readonly retry: () => void }
  | { readonly kind: "closed" };

// [LAW:one-source-of-truth] What one renderer holds in the host, each of its
// own ids to the host's, released once the next renderer has answered its
// start, or at close: the owner every id the host minted for it names.
interface Held {
  readonly watches: Map<WatchId, WatchId>;
  readonly holds: Map<StorageHoldId, StorageHoldId>;
}

// A renderer's own id, as the host minted its own for it.
interface Minted<T> {
  readonly by: Held;
  readonly id: T;
}

export function processRenderer(own: ProcessOwner): RendererLink {
  const { clock, log } = own;
  let phase: Phase = { kind: "idle" };
  let generation = 0;
  // Renderers in a row that ended young.
  let young = 0;
  // Inputs refused while none was live, said once the next one is.
  let refused = 0;
  // Links that ended, whose holds the next start releases.
  const gone: Link[] = [];
  // [LAW:one-source-of-truth] The host's ids for what renderers mint: an id
  // the host sees is its own, never repeated across renderers, and names the
  // link and the renderer's own id.
  let minted = 0;
  const mint = <T extends number>(): T => ++minted as T;
  const effects = new Map<EffectId, Minted<EffectId>>();
  const watches = new Map<WatchId, Minted<WatchId>>();

  const current = (): Link | null =>
    phase.kind === "starting" || phase.kind === "live" ? phase.link : null;
  const down = (): RendererDown =>
    new RendererDown(
      phase.kind === "down"
        ? `renderer main is down: ${phase.why}`
        : phase.kind === "closed"
          ? "renderer main is closed"
          : "renderer main has not started",
    );

  // The host's reaches as one renderer reaches them: the ids it mints for
  // watches and storage holds become the host's, held by its link.
  const reachesFor = (held: Held): AdapterToHost => ({
    ...own.reaches,
    watches: {
      watch: (id, key, targets) => {
        const host = mint<WatchId>();
        watches.set(host, { by: held, id });
        held.watches.set(id, host);
        own.reaches.watches.watch(host, key, targets);
      },
      unwatch: (id) => {
        const host = hostIdOf(held.watches, id);
        watches.delete(host);
        held.watches.delete(id);
        own.reaches.watches.unwatch(host);
      },
    },
    storage: {
      // Every load of a state holds its folders again, under the same id.
      hold: (id, folders) => {
        const host = held.holds.get(id) ?? mint<StorageHoldId>();
        held.holds.set(id, host);
        own.reaches.storage.hold(host, folders);
      },
      release: (id) => {
        const host = hostIdOf(held.holds, id);
        held.holds.delete(id);
        own.reaches.storage.release(host);
      },
    },
  });

  // [LAW:no-ambient-temporal-coupling] What an ended renderer held stays held
  // until the next one has answered its start, so a folder both watch is
  // never closed and reopened: a directory watch leaks on macOS when it is.
  // At close, everything goes.
  const releaseGone = (): void => {
    for (const { held } of gone.splice(0)) {
      for (const host of held.watches.values()) {
        watches.delete(host);
        own.reaches.watches.unwatch(host);
      }
      for (const host of held.holds.values()) own.reaches.storage.release(host);
      for (const [host, effect] of effects)
        if (effect.by === held) effects.delete(host);
    }
  };

  const write = (channel: Channel, line: HostLine): void =>
    channel.write(`${JSON.stringify(line)}\n`);

  const spawn = (): void => {
    const generationOf = ++generation;
    const kill = new AbortController();
    // A channel's output arrives on a later turn, so the link its lines reach
    // is set before the child can have said anything.
    let heardBy: (text: string) => void = () => {};
    const stdout = lineSplitter((text) => heardBy(text));
    const stderr = lineSplitter((text) =>
      log("warn", `renderer main[${generationOf}]: ${text}`),
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
    const held: Held = { watches: new Map(), holds: new Map() };
    const link: Link = {
      generation: generationOf,
      channel,
      kill,
      spawnedAt: clock.monotonic(),
      hung: false,
      refusal: null,
      held,
      usage: null,
      pingSentAt: null,
      lines: rendererOverLines({
        send: (line) => write(channel, line),
        host: reachesFor(held),
        fault: (message) =>
          log("error", `renderer main[${generationOf}]: ${message}`),
      }),
    };
    phase = { kind: "starting", link, queued: [] };
    write(channel, { kind: "boot", boot: own.boot });
    // [LAW:no-ambient-temporal-coupling] The start heads the queue: the host's
    // one path reaches it in the order it is called, so every input after
    // this is queued behind the state it changes.
    const start = own.start();
    heardBy = (text) => heard(link, start, text);
    void channel.ended.then((result) => {
      stdout.end();
      stderr.end();
      ended(
        link,
        link.hung
          ? `stopped answering for ${HUNG_AFTER_MS / 1000} s`
          : link.refusal !== null
            ? `refused its boot: ${link.refusal}`
            : result.ok
              ? "exited"
              : whyFailed(result),
      );
    });
  };

  const heard = (link: Link, start: Promise<void>, text: string): void => {
    let line: RendererLine;
    try {
      line = JSON.parse(text) as RendererLine;
    } catch {
      // [LAW:no-silent-failure] A line that is not the wire's is said.
      log("warn", `renderer main[${link.generation}]: ${text}`);
      return;
    }
    switch (line.kind) {
      case "started":
        started(link, start);
        return;
      // [LAW:no-silent-failure] Its end says why, on the ⚠ as in the log;
      // the stack is the log's alone.
      case "refused":
        link.refusal = line.failure.message;
        log(
          "error",
          `renderer main[${link.generation}] refused its boot: ${line.failure.detail}`,
        );
        return;
      default:
        link.lines.heard(line);
    }
  };

  const started = (link: Link, start: Promise<void>): void => {
    if (phase.kind !== "starting" || phase.link !== link) return;
    const { queued } = phase;
    phase = { kind: "live", link };
    // [LAW:nothing-unseen] The start, with what was refused while none ran.
    log(
      "info",
      `renderer main[${link.generation}] started pid=${link.channel.pid ?? "-"} refused-while-down=${refused}`,
    );
    refused = 0;
    for (const send of queued) send();
    // [LAW:no-ambient-temporal-coupling] What an ended renderer held goes once
    // this one has started and taken its start, and stays if it ends first.
    void start.then(() => {
      if (current() === link) releaseGone();
    });
    // Its memory is read at once, not a period after its boot.
    ping(link);
  };

  const ended = (link: Link, how: string): void => {
    link.lines.ended(new RendererDown(`renderer main ${how}`));
    gone.push(link);
    if (phase.kind === "closed") return;
    const queued = phase.kind === "starting" ? phase.queued : [];
    const lived = clock.monotonic() - link.spawnedAt;
    young = lived < YOUNG_MS ? young + 1 : 0;
    const delay = backoffMs(young);
    const why = `renderer main[${link.generation}] ${how}`;
    phase = {
      kind: "down",
      why: how,
      retry: clock.after(delay, () => {
        if (phase.kind === "down") spawn();
      }),
    };
    // What waited for a start that never came fails as no renderer's.
    for (const send of queued) send();
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
      link.hung = true;
      link.kill.abort(new Error("the renderer stopped answering"));
      return;
    }
    if (phase.kind === "live" && link.pingSentAt === null) ping(link);
  };
  const ping = (link: Link): void => {
    link.pingSentAt = clock.monotonic();
    link.lines.ping().then(
      (usage) => {
        link.usage = usage;
        link.pingSentAt = null;
      },
      // Its end says why: a ping a gone renderer owed says nothing more.
      () => {},
    );
  };
  let stopPings: () => void = () => {};

  // [LAW:single-enforcer] An input no renderer takes: counted, and said with
  // the count as the next one starts.
  const refusal = (why: RendererDown): RendererDown => {
    refused++;
    return why;
  };
  // An input goes to the live renderer, waits for the one starting, or fails
  // as no renderer's.
  const sent = <O>(answer: (link: Link) => Promise<O>): Promise<O> => {
    if (phase.kind === "live") return answer(phase.link);
    if (phase.kind === "starting") {
      const { queued } = phase;
      return new Promise<O>((resolve, reject) =>
        queued.push(() => {
          (phase.kind === "live"
            ? answer(phase.link)
            : Promise.reject(refusal(down()))
          ).then(resolve, reject);
        }),
      );
    }
    return Promise.reject(refusal(down()));
  };

  // The ids an input names are the renderer's own again; the ids its output
  // names are the host's.
  const event = (input: EventInput): Promise<RendererOutput> =>
    sent(async (link) => {
      const { event: e } = input;
      let toSend: EventInput = input;
      if (e.kind === "effect-done") {
        const effect = effects.get(e.of);
        // [LAW:no-silent-failure] The renderer that owed this one is gone, so
        // there is no one to tell.
        if (effect === undefined || effect.by !== link.held)
          throw new Error(
            `renderer main: effect ${e.of} was returned by a renderer that has ended`,
          );
        effects.delete(e.of);
        toSend = { ...input, event: { ...e, of: effect.id } };
      }
      const output = await link.lines.renderer.answer(toSend);
      if (output.kind !== "answered") return output;
      return {
        ...output,
        effects: output.effects.map((effect) => {
          const host = mint<EffectId>();
          effects.set(host, { by: link.held, id: effect.id });
          return { ...effect, id: host };
        }),
      };
    });
  const adapter = (input: AdapterInput): Promise<AdapterOutput> =>
    sent(async (link) => {
      const { push } = input;
      if (push.kind !== "watch") return link.lines.renderer.answer(input);
      const watch = watches.get(push.id);
      if (watch === undefined || watch.by !== link.held)
        throw new Error(
          `renderer main: watch ${push.id} was held by a renderer that has ended`,
        );
      return link.lines.renderer.answer({
        ...input,
        push: { ...push, id: watch.id },
      });
    });

  return {
    renderer: rendererOf({ event, adapter }),
    arm: () => {
      if (phase.kind !== "idle") return;
      spawn();
      stopPings = clock.every(PING_PERIOD_MS, pinged, { unref: true });
    },
    close: async () => {
      const link = current();
      const queued = phase.kind === "starting" ? phase.queued : [];
      if (phase.kind === "down") phase.retry();
      phase = { kind: "closed" };
      // What waited for this boot fails as a closed renderer's.
      for (const send of queued) send();
      stopPings();
      if (link !== null) {
        link.channel.end();
        const grace = clock.after(CLOSE_GRACE_MS, () =>
          link.kill.abort(new Error("the daemon closed")),
        );
        await link.channel.ended;
        grace();
      }
      releaseGone();
    },
    process: () => {
      const link = current();
      const pid = link === null ? null : link.channel.pid;
      return link === null || pid === null
        ? null
        : {
            pid,
            usage: link.usage,
            heapSnapshot: (file) =>
              phase.kind === "live" && phase.link === link
                ? link.lines.heapSnapshot(file)
                : Promise.reject(
                    new Error(
                      `renderer main[${link.generation}] is not live, so its heap was not written`,
                    ),
                  ),
          };
    },
  };
}

// [LAW:no-silent-failure] A renderer naming an id it never handed the host is
// a renderer's bug, said.
function hostIdOf<T>(held: ReadonlyMap<T, T>, id: T): T {
  const host = held.get(id);
  if (host === undefined)
    throw new Error(
      `renderer main named ${String(id)}, which it holds none of`,
    );
  return host;
}
