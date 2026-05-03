import net from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, sendOne } from "./protocol";
import type { Response } from "./protocol";

const CONNECT_TIMEOUT_MS = 50;
const TOTAL_BUDGET_MS = 150;
const CLICK_BUDGET_MS = 200;

export interface ClientOutcome {
  ok: boolean;
  output?: string;
  // For diagnostics — never surfaces to the user, only fed to spawn-decision.
  reason?: string;
}

// Try to render via the daemon. Any failure (no socket, refused, timeout,
// version mismatch, unknown error) returns ok:false; the caller spawns a
// detached daemon for the *next* invocation and emits empty output for this
// one. There is no inline render path — see src/index.ts.
//
// [LAW:dataflow-not-control-flow] The outcome is data; the caller's branch
// is uniform: ok→print, !ok→spawn+empty. No special casing per failure mode.
export async function tryRenderViaDaemon(
  hookData: ClaudeHookData,
  args: string[],
  cwd: string,
): Promise<ClientOutcome> {
  let sock: net.Socket | null = null;
  try {
    sock = await connectWithTimeout(socketPath(), CONNECT_TIMEOUT_MS);
    const resp: Response = await sendOne(
      sock,
      {
        v: PROTOCOL_VERSION,
        kind: "render",
        hookData,
        args,
        cwd,
      },
      TOTAL_BUDGET_MS,
    );
    if (resp.ok && "output" in resp) {
      return { ok: true, output: resp.output };
    }
    if (resp.ok) {
      return { ok: false, reason: "unexpected stats response to render" };
    }
    return { ok: false, reason: resp.code };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (sock) sock.destroy();
  }
}

// [LAW:dataflow-not-control-flow] Same pattern as tryRenderViaDaemon: outcome
// is data, caller branches uniformly on ok/!ok.
export async function tryClickViaDaemon(
  verb: string,
  value: string,
): Promise<ClientOutcome> {
  let sock: net.Socket | null = null;
  try {
    sock = await connectWithTimeout(socketPath(), CONNECT_TIMEOUT_MS);
    const resp: Response = await sendOne(
      sock,
      {
        v: PROTOCOL_VERSION,
        kind: "click",
        verb,
        value,
      },
      CLICK_BUDGET_MS,
    );
    if (resp.ok) {
      return { ok: true };
    }
    return { ok: false, reason: resp.code };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (sock) sock.destroy();
  }
}

function connectWithTimeout(
  path: string,
  timeoutMs: number,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("CONNECT_TIMEOUT"));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
