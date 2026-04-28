import net from "node:net";
import process from "node:process";
import { socketPath } from "./paths";
import { PROTOCOL_VERSION, sendOne } from "./protocol";
import type { Response } from "./protocol";
import type { StatsSnapshot } from "./stats";

const CONNECT_TIMEOUT_MS = 200;
const TOTAL_BUDGET_MS = 500;

// Query the running daemon for stats. Does NOT spawn a daemon — stats on a
// dead daemon is meaningless. Exits non-zero on failure with a clear message.
export async function runDaemonStats(args: readonly string[]): Promise<void> {
  const wantJson = args.includes("--json");

  const stats = await fetchStats().catch((e: Error) => {
    process.stderr.write(`daemon-stats: ${e.message}\n`);
    process.stderr.write(
      "Hint: daemon may not be running. Run `claude-powerline` once to spawn it.\n",
    );
    process.exit(1);
  });

  if (!stats) return;

  if (wantJson) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    return;
  }

  process.stdout.write(formatStats(stats));
}

async function fetchStats(): Promise<StatsSnapshot> {
  const sock = await connect(socketPath(), CONNECT_TIMEOUT_MS);
  try {
    const resp: Response = await sendOne(
      sock,
      { v: PROTOCOL_VERSION, kind: "stats" },
      TOTAL_BUDGET_MS,
    );
    if (!resp.ok) {
      throw new Error(`daemon error: ${resp.code} ${resp.error}`);
    }
    if (!("stats" in resp)) {
      throw new Error("daemon returned ok but no stats payload");
    }
    return resp.stats;
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

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtRate(hits: number, misses: number): string {
  const total = hits + misses;
  if (total === 0) return "n/a";
  return `${((hits / total) * 100).toFixed(1)}%`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

export function formatStats(s: StatsSnapshot): string {
  const lines: string[] = [];
  lines.push(`claude-powerline daemon stats`);
  lines.push(``);
  lines.push(`process`);
  lines.push(`  pid           ${s.pid}`);
  lines.push(`  version       ${s.version}`);
  lines.push(`  startedAt     ${s.startedAt}`);
  lines.push(`  uptime        ${fmtUptime(s.uptimeSec)}`);
  lines.push(`  rss           ${fmtBytes(s.rssBytes)}`);
  lines.push(`  heapUsed      ${fmtBytes(s.heapUsedBytes)}`);
  lines.push(``);
  lines.push(`requests`);
  lines.push(`  total         ${s.requests.total}`);
  lines.push(`  errored       ${s.requests.errored}`);
  lines.push(`  timedOut      ${s.requests.timedOut}`);
  lines.push(`  inFlight      ${s.requests.inFlight}`);
  lines.push(``);
  lines.push(`gitCache`);
  lines.push(`  size          ${s.gitCache.size}`);
  lines.push(
    `  hit rate      ${fmtRate(s.gitCache.hits, s.gitCache.misses)} (${s.gitCache.hits} / ${s.gitCache.hits + s.gitCache.misses})`,
  );
  lines.push(`  invalidations ${s.gitCache.invalidations}`);
  lines.push(``);
  lines.push(`usageCache`);
  lines.push(`  size          ${s.usageCache.size}`);
  lines.push(
    `  hit rate      ${fmtRate(s.usageCache.hits, s.usageCache.misses)} (${s.usageCache.hits} / ${s.usageCache.hits + s.usageCache.misses})`,
  );
  lines.push(`  sweeps        ${s.usageCache.sweeps}`);
  lines.push(``);
  lines.push(`watchers`);
  lines.push(`  active        ${s.watchers.active}`);
  lines.push(`  opened        ${s.watchers.opened}`);
  lines.push(`  closed        ${s.watchers.closed}`);
  lines.push(`  evicted       ${s.watchers.evicted}`);
  if (s.nextRestartReason) {
    lines.push(``);
    lines.push(`nextRestart    ${s.nextRestartReason}`);
  }
  return lines.join("\n") + "\n";
}
