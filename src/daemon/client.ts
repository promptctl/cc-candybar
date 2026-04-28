import net from "node:net";
import type { ClaudeHookData } from "../utils/claude";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, sendOne } from "./protocol";
import type { Response } from "./protocol";

const CONNECT_TIMEOUT_MS = 50;
const TOTAL_BUDGET_MS = 150;

export interface ClientOutcome {
  ok: boolean;
  output?: string;
  // For diagnostics — never surfaces to the user, only fed to spawn-decision.
  reason?: string;
}

// Try to render via the daemon. Any failure (no socket, refused, timeout,
// version mismatch, unknown error) returns ok:false; the caller is expected
// to fall through to inline rendering and optionally spawn a new daemon.
//
// [LAW:dataflow-not-control-flow] The outcome is data; the caller's branch
// is uniform: ok→print, !ok→inline+spawn. No special casing per failure mode.
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
    if (resp.ok) {
      return { ok: true, output: resp.output };
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
