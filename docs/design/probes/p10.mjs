// A global zoom hook carrying facts onto a control client's stream. Isolated -L socket only.
import { spawn, execFileSync } from "node:child_process";
const S = "ccb-zg";
const tmux = (...a) => execFileSync("tmux", ["-L", S, "-f", "/dev/null", ...a], { encoding: "utf8" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.TERM = "xterm-256color";
tmux("new-session", "-d", "-s", "A", "-x", "100", "-y", "30");
tmux("new-session", "-d", "-s", "B", "-x", "100", "-y", "30");
tmux("split-window", "-t", "B:0");
const heard = [];
const control = spawn("tmux", ["-L", S, "-C", "attach", "-t", "A"], { stdio: ["pipe", "pipe", "ignore"] });
let held = "";
control.stdout.on("data", (d) => {
  held += d;
  const lines = held.split("\n");
  held = lines.pop();
  heard.push(...lines.filter((l) => !/^%(output|begin|end)\b/.test(l)).map((l) => l.slice(0, 120)));
});
await wait(500);
const name = tmux("list-clients", "-F", "#{client_control_mode} #{client_name}").split("\n").find((l) => l.startsWith("1 ")).slice(2);
console.log("control client:", name);
const msg = (kind) => `display-message -c ${name} "ccb-zoom ${kind} #{session_id} #{window_id} #{window_zoomed_flag}"`;
tmux("set-hook", "-g", "window-zoomed", msg("on"));
tmux("set-hook", "-g", "window-unzoomed", msg("off"));
console.log("global hooks:", tmux("show-hooks", "-g").split("\n").filter((l) => l.includes("zoom")).join(" | "));
for (const step of ["zoom", "unzoom", "zoom", "unzoom"]) {
  heard.push(`-- ${step} in B`);
  tmux("resize-pane", "-Z", "-t", "B:0");
  await wait(300);
}
heard.push("-- control client gone, zoom again");
control.stdin.end();
control.kill();
await wait(400);
let after = "ok";
try { tmux("resize-pane", "-Z", "-t", "B:0"); } catch (e) { after = String(e.message).slice(0, 100); }
await wait(200);
console.log("zoom with the control client gone:", after, "| zoomed now:", tmux("display", "-p", "-t", "B:0", "#{window_zoomed_flag}").trim());
console.log("server messages:", tmux("show-messages").split("\n").filter((l) => /ccb|not found|can't/.test(l)).slice(-3).join(" | "));
console.log(heard.join("\n"));
for (const n of ["A", "B"]) { try { tmux("kill-session", "-t", n); } catch {} }
process.exit(0);
