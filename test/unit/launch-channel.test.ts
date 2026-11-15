import type { LaunchResult } from "../../src/proc/launcher";
import { exits, program, readsStdin } from "../../src/proc/spawner-fake";
import { fakeLauncher, turns } from "../helpers/fake-launcher";
import { heldClock } from "../helpers/held-clock";

// [LAW:behavior-not-structure] A channel launch, as a renderer's process is
// carried: the caller writes its stdin a line at a time and hears each line
// it writes as it completes, and the child's end is the result.

function rig() {
  const clock = heldClock(new Date(1_000_000));
  return { clock, ...fakeLauncher(clock) };
}

// Lets a launch settle, a millisecond of the clock at a time.
async function settled(
  r: ReturnType<typeof rig>,
  result: Promise<LaunchResult>,
): Promise<LaunchResult> {
  let ended: LaunchResult | undefined;
  void result.then((v) => (ended = v));
  for (let i = 0; i < 100 && ended === undefined; i++) {
    r.clock.advance(1);
    await turns();
  }
  if (ended === undefined) throw new Error("the channel never ended");
  return ended;
}

test("each line sent reaches the child's stdin, and each line it writes is heard whole", async () => {
  const r = rig();
  r.spawner.program(program("echoer"), readsStdin("echo"));
  const heard: string[] = [];
  const channel = r.launcher.launchChannel(
    { bin: "echoer", category: "renderer" },
    { stdout: (line) => heard.push(line), stderr: () => {} },
  );
  channel.send('{"k":"input","id":1}');
  channel.send('{"k":"input","id":2}');
  channel.close();
  expect(await settled(r, channel.result)).toMatchObject({ ok: true });
  expect(heard).toEqual(['{"k":"input","id":1}', '{"k":"input","id":2}']);
});

test("what a child says on stderr is heard as it says it, and its end says why", async () => {
  const r = rig();
  r.spawner.program(program("crasher"), exits(1, "", "boom\nbust\n"));
  const said: string[] = [];
  const channel = r.launcher.launchChannel(
    { bin: "crasher", category: "renderer" },
    {
      stdout: () => {
        throw new Error("the crasher writes nothing");
      },
      stderr: (line) => said.push(line),
    },
  );
  expect(await settled(r, channel.result)).toMatchObject({
    ok: false,
    reason: "non-zero",
    exitCode: 1,
    stderr: "",
  });
  expect(said).toEqual(["boom", "bust"]);
  channel.send("after its end");
  await turns();
});

test("a channel launch starts again at once: its caller paces its restarts", async () => {
  const r = rig();
  r.spawner.program(program("echoer"), readsStdin("echo"));
  const quiet = { stdout: () => {}, stderr: () => {} };
  const first = r.launcher.launchChannel(
    { bin: "echoer", category: "renderer" },
    quiet,
  );
  first.close();
  await settled(r, first.result);
  const second = r.launcher.launchChannel(
    { bin: "echoer", category: "renderer" },
    quiet,
  );
  second.close();
  expect(await settled(r, second.result)).toMatchObject({ ok: true });
});
