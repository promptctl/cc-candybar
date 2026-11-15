// The two ways a renderer runs: in a process of its own, which is how the
// daemon serves every bar, and in this one, for a test's worker and the page
// in site/, which have no process to start. The supervisor sees one link
// either way (src/daemon/renderer-supervisor.ts).

import type { Host } from "../host";
import type { Launcher, LaunchResult } from "../proc/launcher";
import { whyFailed } from "../proc/launcher";
import type { RendererBoot } from "../renderer-interface/boot.js";
import type {
  AdapterOutput,
  RendererInput,
  RendererOutput,
} from "../renderer-interface/interface.js";
import { wireRenderer } from "../renderer-interface/wire.js";
import { loadMainRenderer } from "../renderer/main.js";
import type { LinkSigner } from "../click/link-signer.js";
import type { DoctorStores } from "../doctor/ports";
import type { Timekeeper } from "../time";
import type { Instant } from "../utils/instant.js";
import type { DaemonLogger } from "../utils/logger";
import type { Gates } from "./foundations/gates";
import { heapCapOf } from "./limits";
import { locations, type DaemonPaths } from "./paths";
import type { DaemonStorage, RunningBundle } from "./daemon";
import type { StartRenderer } from "./renderer-supervisor.js";

// What a daemon hands the way its renderers start.
export interface RendererOwner {
  // [LAW:no-ambient-temporal-coupling] The renderer's own launcher: its
  // close is the teardown's last step, after the renderer's own.
  readonly launcher: Launcher;
  readonly bundle: RunningBundle;
  readonly log: DaemonLogger;
  readonly clock: Timekeeper;
  readonly now: () => Instant;
  readonly host: Host;
  // The renderer's share of the memory limit (`memoryShares`).
  readonly memoryShareBytes: number;
}

export type Renderers = (own: RendererOwner) => StartRenderer;

// How a renderer's process ended, said as the start after it says it.
const endedOf = (result: LaunchResult): string =>
  result.ok ? `exited with code ${result.exitCode}` : whyFailed(result);

// [LAW:single-enforcer] A renderer in its own process: the bundle the daemon
// runs, started again as its `renderer` subcommand, talking over its stdio.
export function processRenderers(
  paths: Pick<DaemonPaths, "state" | "sessionState" | "settingsHistory">,
): Renderers {
  return (own) => (host, generation) => {
    const boot: RendererBoot = {
      generation,
      stateDir: paths.state,
      sessionState: paths.sessionState,
      settingsHistory: paths.settingsHistory,
      memoryShareBytes: own.memoryShareBytes,
      bundle: own.bundle.path,
    };
    const [bin, ...flags] = own.bundle.node;
    let heard: (line: string) => void = () => {};
    const channel = own.launcher.launchChannel(
      {
        bin: bin!,
        args: [
          ...flags,
          `--max-old-space-size=${heapCapOf(own.memoryShareBytes)}`,
          own.bundle.entry,
          "renderer",
          JSON.stringify(boot),
        ],
        category: "renderer",
      },
      (line) => {
        // [LAW:no-silent-failure] A line the renderer should not have sent
        // is its bug: said, and the renderer is ended, as one that crashed.
        try {
          heard(line);
        } catch (thrown) {
          own.log("error", `renderer line refused: ${String(thrown)}`);
          channel.close();
        }
      },
    );
    const wire = wireRenderer(
      {
        send: channel.send,
        hear: (hear) => {
          heard = hear;
        },
      },
      host,
    );
    const ended = channel.result.then((result) => {
      const words = endedOf(result);
      wire.fail(new Error(`the renderer's process ${words}`));
      const said = result.stderr.trim();
      if (said !== "") own.log("warn", `renderer stderr: ${said}`);
      return words;
    });
    return {
      answer: wire.answer,
      ended,
      end: async () => {
        channel.close();
        await ended;
      },
    };
  };
}

// What a renderer in this process is built over, which a process of its own
// builds from the files it is pointed at.
export interface InProcessParts {
  readonly storage: (log: DaemonLogger) => DaemonStorage;
  readonly doctorStores: DoctorStores;
  readonly linkSigner: LinkSigner;
  readonly gates: Gates;
  readonly stateDir: string;
}

// A renderer in this process, for what has no process to start it in. It
// ends only with its daemon.
export function inProcessRenderers(parts: InProcessParts): Renderers {
  return (own) => (host, generation) => {
    const renderer = loadMainRenderer({
      generation,
      clock: own.clock,
      now: own.now,
      storage: { ...parts.storage(own.log), doctor: parts.doctorStores },
      linkSigner: parts.linkSigner,
      stateDir: parts.stateDir,
      locations: locations(own.host),
      env: own.host.env,
      home: own.host.home,
      gates: parts.gates,
      bundle: own.bundle.path,
      memoryLimitBytes: own.memoryShareBytes,
    }).start(host);
    let end!: (words: string) => void;
    const ended = new Promise<string>((resolve) => (end = resolve));
    return {
      answer: async (input: RendererInput) => {
        const from = own.clock.monotonic();
        // [LAW:types-are-the-program] exception: each input's output is its
        // own kind's; one call cannot name it.
        const output = await (
          renderer.answer as (
            input: RendererInput,
          ) => Promise<RendererOutput | AdapterOutput>
        )(input);
        return { output, tookMs: own.clock.monotonic() - from };
      },
      ended,
      end: async () => end("ended with its daemon"),
    };
  };
}
