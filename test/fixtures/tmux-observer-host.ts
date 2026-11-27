// The host and the guardian have independent lifetimes. The test kills this
// real host after the observer's first publication on its private server.
import { processWorld } from "../../src/host";
import { productionTmuxServerObserver } from "../../src/daemon/tmux-server-observer";
const [socket, bundle, tmp] = process.argv.slice(2);
const stop = productionTmuxServerObserver(
  processWorld().launcher,
  [process.execPath],
  bundle!,
  tmp!,
).observe(socket!, {
  snapshot: () => process.stdout.write("snapshot\n"),
  lost: (why) => process.stderr.write(why + "\n"),
});
process.stdin.resume();
process.stdin.on("end", stop);
