import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
const W = "/tmp/ccb-probe/wt";
const { prepareIsolatedDaemonEnv, spawnDaemonWithEnv } = await import(`${W}/test/helpers/spawn-isolated-daemon.ts`);
const { render, sendClick } = await import(`${W}/test/helpers/daemon-e2e.ts`);
const { drawnLinks, describeLink } = await import(`${W}/test/helpers/drive-bar.ts`);
const { PARENT_PID_ENV } = await import(`${W}/src/daemon/parent-watchdog.ts`);
const { BAR_SESSION_ID } = await import(`${W}/scripts/lib/hook-data.ts`);
const { withStamp } = await import(`${W}/scripts/version-stamp.cjs`);
const { encodeFrame, makeFrameReader } = await import(`${W}/src/daemon/protocol.ts`);

const cwd = "/Users/bmf/code/cc-candybar/.claude/worktrees/synthetic-zooming-wind";
const spawn = async (prefix: string) => {
  const e = prepareIsolatedDaemonEnv(prefix);
  const claude = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-claude-`));
  const d = await spawnDaemonWithEnv({
    ...e.env,
    [PARENT_PID_ENV]: String(process.pid),
    CC_CANDYBAR_REGISTRY_URL: "http://127.0.0.1:1",
    CLAUDE_CONFIG_DIR: claude,
    NODE_OPTIONS: withStamp(process.env.NODE_OPTIONS),
  }, { bin: `${W}/node_modules/.bin/tsx`, args: [`${W}/src/index.ts`] });
  return { env: e.env, sock: e.env.CC_CANDYBAR_SOCKET as string, d };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (n: number) => Math.round(n * 10) / 10;
const out: any = {};

setTimeout(() => {
  console.log("TIMED OUT", JSON.stringify(out));
  process.exit(2);
}, 60000);
const facts = await spawn("ccb-f");
const draw = await spawn("ccb-d");
const sid = BAR_SESSION_ID;
const rows = (s: string) => s.split("\n").filter((l) => l.length > 0).length;
try {
  const f0 = await render(facts.sock, sid, cwd);
  const d0 = await render(draw.sock, sid, cwd);
  const open = drawnLinks(d0).find((l: any) => describeLink(l).includes("candybar.menu open"));
  const inner = open.url.slice("cc-candybar://".length);
  const routed = `cc-candybar://to/dev/${inner}`;
  out.link = { plain: open.url.slice(0, 50), routed: routed.slice(0, 60) };

  // A click before anything is attached.
  const unattached = await sendClick(facts.sock, routed);
  out.unattached = unattached;

  // The drawing side dials out and holds the connection.
  const delivered: number[] = [];
  const answered: number[] = [];
  let sent = 0;
  const line = net.createConnection({ path: facts.sock });
  await new Promise((r) => line.once("connect", r));
  line.on(
    "data",
    makeFrameReader(
      (frame: any) => {
        delivered.push(performance.now() - sent);
        void sendClick(draw.sock, `cc-candybar://${frame.verb}/${frame.value}`).then((resp: any) => {
          answered.push(performance.now() - sent);
          if (!resp.ok) out.bridgeRefused = resp;
        });
      },
      (e: Error) => {
        out.bridgeError = String(e);
      },
    ),
  );
  line.write(encodeFrame({ kind: "attach", id: "dev" }));
  await new Promise((r) => setTimeout(r, 200));

  const acks: number[] = [];
  for (let i = 0; i < 30; i++) {
    sent = performance.now();
    const resp = await sendClick(facts.sock, routed);
    acks.push(performance.now() - sent);
    if (!resp.ok) out.routeRefused = resp;
    while (answered.length <= i) await new Promise((r) => setTimeout(r, 2));
  }
  out.latencyMs = {
    n: acks.length,
    factsAcked: { median: round(median(acks)), max: round(Math.max(...acks)) },
    reachedDrawSide: { median: round(median(delivered)), max: round(Math.max(...delivered)) },
    drawSideApplied: { median: round(median(answered)), max: round(Math.max(...answered)) },
  };

  const d1 = await render(draw.sock, sid, cwd);
  const f1 = await render(facts.sock, sid, cwd);
  out.bars = { closedRows: rows(d0), drawAfterClick: rows(d1), factsAfterClick: rows(f1), factsUnchanged: f1 === f0, drawChanged: d1 !== d0 };

  await new Promise((r) => setTimeout(r, 1500));
  const stateOf = (env: any) => {
    const p = path.join(env.XDG_STATE_HOME, "cc-candybar", "session-state.json");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  };
  out.persisted = {
    drawHasPick: stateOf(draw.env).includes("candybar.menu"),
    factsHasPick: stateOf(facts.env).includes("candybar.menu"),
  };

  // The drawing side goes away.
  line.destroy();
  await new Promise((r) => setTimeout(r, 200));
  out.afterDetach = await sendClick(facts.sock, routed);
  out.factsStillServing = rows(await render(facts.sock, sid, cwd));
} finally {
  console.log(JSON.stringify(out, null, 1));
  facts.d.killTree();
  draw.d.killTree();
}
process.exit(0);
