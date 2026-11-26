import { WindowFollowers } from "../src/daemon/window-followers";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { ChannelOpts, LaunchResult } from "../src/proc/launcher";
import { heldClock } from "./helpers/held-clock";

test("placement changes reuse a follower and a new session waits for the pane's prior owner to exit", async () => {
  const clock = heldClock(new Date(0));
  const channels: Array<{
    opts: ChannelOpts;
    write: jest.Mock;
    end: jest.Mock;
    finish: () => void;
  }> = [];
  const launchChannel = (opts: ChannelOpts) => {
    let finish!: () => void;
    const ended = new Promise<LaunchResult>((resolve) => {
      finish = () => resolve({ ok: true, stdout: "", stderr: "", exitCode: 0 });
    });
    const write = jest.fn(),
      end = jest.fn();
    channels.push({ opts, write, end, finish });
    return { pid: 10, write, end, ended };
  };
  const windows = new WindowFollowers(
    { launchChannel },
    { node: ["node"], bundle: "/test/dist/index.mjs", socket: "/host/socket" },
    clock,
    jest.fn(),
    true,
  );
  const a = sessionIdOf("a"),
    b = sessionIdOf("b");
  const pane = { socket: "/tmp/tmux", pane: "%73", truecolor: null };
  windows.declare(new Map([[a, { pane, placement: "docked" }]]));
  const first = channels[0]!;
  windows.declare(new Map([[a, { pane, placement: "inset" }]]));
  expect(channels).toHaveLength(1);
  expect(JSON.parse(first.write.mock.calls[0]![0])).toEqual({
    kind: "placement",
    value: "inset",
  });
  first.opts.heard.stdout('{"kind":"issue","reason":"Needs Accessibility"}\n');
  expect(windows.issue(a)).toBe("Needs Accessibility");
  windows.declare(new Map([[b, { pane, placement: "inset" }]]));
  expect(first.end).toHaveBeenCalledTimes(1);
  expect(channels).toHaveLength(1);
  expect(windows.issue(a)).toBeUndefined();
  first.finish();
  await clock.settle(0);
  expect(channels).toHaveLength(2);
  expect(channels[1]!.opts.args).toContain(b);
  const closed = windows.close();
  expect(channels[1]!.end).toHaveBeenCalledTimes(1);
  channels[1]!.finish();
  await closed;
});
