// What one control client on session A hears about session B. Isolated -L socket only.
import { spawn, execFileSync } from "node:child_process";
const S = "ccb-cov";
const tmux = (...a) => execFileSync("tmux", ["-L", S, "-f", "/dev/null", ...a], { encoding: "utf8" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.TERM = "xterm-256color";

tmux("new-session", "-d", "-s", "A", "-x", "100", "-y", "30");
tmux("new-session", "-d", "-s", "B", "-x", "100", "-y", "30");
tmux("new-window", "-t", "B");
tmux("split-window", "-t", "B:1");

const heard = [];
let step = "start";
const control = spawn("tmux", ["-L", S, "-C", "attach", "-t", "A"], { stdio: ["pipe", "pipe", "ignore"] });
let held = "";
control.stdout.on("data", (d) => {
  held += d;
  const lines = held.split("\n");
  held = lines.pop();
  for (const l of lines) {
    if (!l.startsWith("%") || /^%(output|extended-output|begin|end|error)\b/.test(l)) continue;
    heard.push([step, l.slice(0, 90)]);
  }
});
await wait(500);
const show = (t) => console.log(`\n== ${t}\n${tmux("list-sessions", "-F", "#{session_name} attached=#{session_attached}")}${tmux("list-clients", "-F", "client=#{client_session} control=#{client_control_mode} flags=#{client_flags}")}`);
show("control client on A");

const act = async (name, fn) => { step = name; fn(); await wait(400); };
await act("select-window in B", () => tmux("select-window", "-t", "B:0"));
await act("select-window back in B", () => tmux("select-window", "-t", "B:1"));
await act("select-pane in B", () => tmux("select-pane", "-t", "B:1.0"));
await act("zoom in B", () => tmux("resize-pane", "-Z", "-t", "B:1"));
await act("unzoom in B", () => tmux("resize-pane", "-Z", "-t", "B:1"));

step = "client attach to B";
const viewer = spawn("script", ["-q", "/tmp/ccb-osc/viewer.out", "tmux", "-L", S, "attach", "-t", "B"], { stdio: ["ignore", "ignore", "ignore"] });
await wait(800);
show("after a real client attached to B");
await act("client switch to A", () => tmux("switch-client", "-c", tmux("list-clients", "-t", "B", "-F", "#{client_name}").trim(), "-t", "A"));
step = "client detach";
const viewerName = tmux("list-clients", "-F", "#{client_control_mode} #{client_name}").split("\n").find((l) => l.startsWith("0 ")).slice(2);
tmux("detach-client", "-t", viewerName);
await wait(600);
show("after detach");
viewer.kill();

console.log("\n== heard by the control client on A");
for (const s of new Set(heard.map(([x]) => x))) {
  console.log(`[${s}]`);
  for (const [x, l] of heard) if (x === s) console.log(`  ${l}`);
}
control.stdin.end();
for (const name of ["A", "B"]) { try { tmux("kill-session", "-t", name); } catch {} }
process.exit(0);
