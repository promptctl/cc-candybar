// [LAW:single-enforcer] The `vars` / `segments` / `config` CLIs are ONE behavior
// — fetch a debug snapshot from the running daemon and render it — parameterized
// by `what`, not three commands. The daemon's `debug` protocol message is the
// single introspection authority (src/daemon/debug.ts produces DebugSnapshot);
// this is its client binding, the mirror of client-stats.ts. Like daemon-stats,
// it does NOT spawn a daemon: introspecting a dead daemon is meaningless.

import net from "node:net";
import process from "node:process";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, sendOne } from "./protocol";
import type { Response } from "./protocol";
import type {
  DebugSnapshot,
  DebugWhat,
  SegmentSnapshot,
  VarSnapshot,
} from "./debug-types";
import type { DslConfig } from "../config/dsl-types";

const CONNECT_TIMEOUT_MS = 200;
const TOTAL_BUDGET_MS = 500;

// `cc-candybar <vars|segments|config> [--json]` — `what` selects the projection.
export async function runDebug(
  what: DebugWhat,
  args: readonly string[],
): Promise<void> {
  const wantJson = args.includes("--json");

  const snapshot = await fetchDebug(what).catch((e: Error) => {
    process.stderr.write(`${what}: ${e.message}\n`);
    process.stderr.write(
      "Hint: daemon may not be running. Run `cc-candybar` once to spawn it.\n",
    );
    process.exit(1);
  });

  if (!snapshot) return;

  if (wantJson) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatDebug(snapshot));
}

async function fetchDebug(what: DebugWhat): Promise<DebugSnapshot> {
  const sock = await connect(socketPath(), CONNECT_TIMEOUT_MS);
  try {
    const resp: Response = await sendOne(
      sock,
      { v: PROTOCOL_VERSION, kind: "debug", what },
      TOTAL_BUDGET_MS,
    );
    if (!resp.ok) {
      throw new Error(`daemon error: ${resp.code} ${resp.error}`);
    }
    if (!("debug" in resp)) {
      throw new Error("daemon returned ok but no debug payload");
    }
    return resp.debug;
  } finally {
    sock.destroy();
  }
}

function connect(path: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("connect timeout (no daemon listening?)"));
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

// [LAW:types-are-the-program] One total fold over the DebugSnapshot union; each
// arm renders its own shape. The switch is exhaustive (the `never` default makes
// a new `what` a compile error here), so the renderer can never fall out of
// lockstep with the protocol's `what` set — the projection is residue of the
// union, not a hand-maintained dispatch.
export function formatDebug(s: DebugSnapshot): string {
  switch (s.what) {
    case "vars":
      return formatVars(s.vars);
    case "segments":
      return formatSegments(s.segments);
    case "config":
      return formatConfig(s.config);
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

function formatVars(vars: readonly VarSnapshot[]): string {
  if (vars.length === 0) return "no variables (DSL not active)\n";
  const lines: string[] = [`variables (${vars.length})`, ``];
  const nameW = vars.reduce((w, v) => Math.max(w, v.name.length), 4);
  const srcW = vars.reduce((w, v) => Math.max(w, (v.source ?? "—").length), 6);
  for (const v of vars) {
    const age = v.ageMs === null ? "" : `  ${fmtAge(v.ageMs)}`;
    const err = v.lastError ? `  ✗ ${v.lastError.message}` : "";
    lines.push(
      `  ${v.name.padEnd(nameW)}  ${(v.source ?? "—").padEnd(srcW)}  ${v.type.padEnd(7)}  ${fmtValue(v.value)}${age}${err}`,
    );
  }
  return lines.join("\n") + "\n";
}

function formatSegments(segments: readonly SegmentSnapshot[]): string {
  if (segments.length === 0) return "no segments (DSL not active)\n";
  const lines: string[] = [`segments (${segments.length})`, ``];
  for (const seg of segments) {
    lines.push(`  ${seg.name}`);
    lines.push(`    template  ${seg.template}`);
    if (seg.referencedVars.length > 0) {
      lines.push(`    vars      ${seg.referencedVars.join(", ")}`);
    }
    if (seg.lastRender !== null) {
      lines.push(`    last      ${seg.lastRender}`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatConfig(config: DslConfig | null): string {
  if (config === null) return "config: DSL not active\n";
  return JSON.stringify(config, null, 2) + "\n";
}

function fmtValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}

function fmtAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}
