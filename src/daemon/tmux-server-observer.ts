import { randomBytes } from "node:crypto";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { OWNER_CONTEXT, type Launcher } from "../proc/launcher.js";
import { runTmuxAsync } from "../proc/tmux.js";
import { ObserverServer } from "./tmux-observer-hooks.js";

export interface TmuxServerObserver {
  observe(
    socket: string,
    events: {
      snapshot: (raw: string) => void;
      lost: (reason: string) => void;
    },
  ): () => void;
}
const messageOf = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// [LAW:no-ambient-temporal-coupling] The detached guardian's socket is its
// lifeline, in both directions. It survives a host SIGKILL to retire hooks.
// Conversely, a host that sees the guardian die can retire its partial setup.
export function productionTmuxServerObserver(
  launcher: Launcher,
  node: readonly string[],
  bundle: string,
  tmp: string,
): TmuxServerObserver {
  return {
    observe(socket, events) {
      const token = randomBytes(16).toString("hex");
      let directory: string;
      try {
        directory = mkdtempSync(join(tmp, "ccb-o-"));
      } catch (err) {
        events.lost(
          "could not create the tmux observer lifeline: " + messageOf(err),
        );
        return () => {};
      }
      const endpoint = join(directory, "s");
      let removed = false;
      let retired = false;
      let peer: Socket | undefined;
      let lease: ObserverServer | undefined;
      let released = false;
      let ended = false;
      const waiting = new Set<Socket>();
      const host = createServer({ allowHalfOpen: true }, (candidate) => {
        waiting.add(candidate);
        const reader = createInterface({
          input: candidate,
          crlfDelay: Infinity,
        });
        reader.on("error", (err) => {
          if (candidate === peer) finish(messageOf(err));
        });
        candidate.on("close", () => {
          waiting.delete(candidate);
          if (candidate === peer) finish("tmux guardian disconnected");
        });
        candidate.on("end", () => {
          candidate.end();
        });
        reader.on("line", (line) => {
          if (peer !== candidate) {
            const hello = line.split(" ");
            if (
              retired ||
              peer ||
              hello.length !== 2 ||
              hello[0] !== token ||
              !/^(?:[1-9]\d*|-)$/.test(hello[1]!)
            ) {
              candidate.destroy();
              return;
            }
            peer = candidate;
            waiting.delete(candidate);
            if (hello[1] !== "-")
              lease = new ObserverServer(launcher, socket, token, hello[1]!);
            stopListening();
            candidate.write("observe\n");
            return;
          }
          try {
            const event: unknown = JSON.parse(line);
            if (
              !Array.isArray(event) ||
              event.length !== 2 ||
              typeof event[1] !== "string"
            )
              throw new Error("invalid tmux guardian event");
            if (event[0] === "snapshot") {
              if (!retired) events.snapshot(event[1]);
            } else if (event[0] === "end" || event[0] === "cleanup-failed") {
              released = event[0] === "end";
              finish(event[1] || "tmux guardian ended");
            } else throw new Error("unknown tmux guardian event");
          } catch (err) {
            finish(messageOf(err));
          }
        });
      });
      const startup = launcher.clock.after("tmux observer startup", 8000, () =>
        finish("tmux observer did not register"),
      );
      function stopListening() {
        startup();
        if (host.listening) host.close();
        if (!removed) {
          removed = true;
          rmSync(endpoint, { force: true });
          rmdirSync(directory);
        }
        for (const candidate of waiting) candidate.destroy();
        waiting.clear();
      }
      function finish(reason: string) {
        if (ended) return;
        ended = true;
        stopListening();
        peer?.end();
        if (!retired) events.lost(reason);
        if (!released && lease)
          launcher.clock.detach("retire disconnected tmux observer", () =>
            lease!.retire(),
          );
      }
      host.on("error", (err) => finish(messageOf(err)));
      host.listen(endpoint, () => {
        if (retired || ended) {
          stopListening();
          return;
        }
        const ran = launcher.launchDetachedSync({
          ...OWNER_CONTEXT,
          bin: node[0]!,
          args: [
            ...node.slice(1),
            bundle,
            "tmux-observer",
            socket,
            token,
            endpoint,
          ],
          category: "frames.visibility",
        });
        if (!ran.ok)
          finish(
            "could not launch tmux guardian: " + (ran.stderr || ran.reason),
          );
      });
      return () => {
        retired = true;
        stopListening();
        peer?.end();
      };
    },
  };
}

// No attach and no control-mode client. The only data crossing the private Unix
// lifeline are authenticated startup, bounded metadata snapshots, and release.
export async function runTmuxObserver(
  launcher: Launcher,
  args: readonly string[],
): Promise<void> {
  const [socket, token, endpoint] = args;
  if (
    args.length !== 3 ||
    !socket ||
    !token ||
    !/^[0-9a-f]{32}$/.test(token) ||
    !endpoint ||
    !endpoint.startsWith("/")
  )
    throw new Error("invalid tmux observer invocation");
  const link = createConnection({
    path: endpoint,
    allowHalfOpen: true,
  });
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  link.on("end", stop);
  link.on("close", stop);
  link.on("error", stop);
  const lines = createInterface({ input: link, crlfDelay: Infinity });
  lines.on("error", stop);
  let server: ObserverServer | undefined;
  let reason = "";
  let cleaned = true;
  try {
    const ready = new Promise<boolean>((resolve) => {
      lines.once("line", (line) => resolve(line === "observe"));
      lifetime.signal.addEventListener("abort", () => resolve(false), {
        once: true,
      });
    });
    const identity = await runTmuxAsync(
      launcher,
      { socket },
      "frames.visibility",
      ["-N", "display-message", "-p", "#{pid}"],
    );
    if (identity.kind !== "ok") throw new Error(identity.reason);
    const pid = identity.stdout.trim();
    server = new ObserverServer(launcher, socket, token, pid);
    if (lifetime.signal.aborted) return;
    link.write(token + " " + pid + "\n");
    if (!(await ready)) return;
    await server.arm();
    while (!lifetime.signal.aborted) {
      const before = await server.pending();
      if (before.renew) await server.renew();
      const raw = await server.snapshot();
      const after = await server.pending();
      // A topology event crossed this read. Its wake is already queued
      // (or still sticky), so no superseded result reaches a consumer.
      if (!after.dirty && !after.renew && !lifetime.signal.aborted)
        await new Promise<void>((resolve, reject) => {
          link.write(JSON.stringify(["snapshot", raw]) + "\n", (err) =>
            err ? reject(err) : resolve(),
          );
        });
      await server.wait(lifetime.signal);
    }
  } catch (err) {
    reason = messageOf(err);
    if (!server && !link.destroyed) link.write(token + " -\n");
  } finally {
    try {
      await server?.retire();
    } catch (err) {
      cleaned = false;
      reason += "; tmux hook cleanup: " + messageOf(err);
    }
    lines.close();
    if (!link.destroyed)
      link.end(
        JSON.stringify([cleaned ? "end" : "cleanup-failed", reason]) + "\n",
      );
  }
}
