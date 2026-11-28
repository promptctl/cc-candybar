import { SOURCE_PANE_CLOSED } from "../src/bar-window/exit";
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
    finish: (exit?: LaunchResult) => void;
  }> = [];
  const launchChannel = (opts: ChannelOpts) => {
    let finish!: (exit?: LaunchResult) => void;
    const ended = new Promise<LaunchResult>((resolve) => {
      finish = (exit) =>
        resolve(exit ?? { ok: true, stdout: "", stderr: "", exitCode: 0 });
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
  channels[1]!.finish({
    ok: false,
    reason: "non-zero",
    exitCode: SOURCE_PANE_CLOSED,
    stdout: "",
    stderr: "",
    signal: null,
  });
  await clock.settle(0);
  windows.declare(new Map([[b, { pane, placement: "inset" }]]));
  await clock.settle(6000);
  expect(channels).toHaveLength(2);
  expect(windows.issue(b)).toBe("Claude's tmux pane closed");
  windows.declare(
    new Map([[b, { pane: { ...pane, pane: "%74" }, placement: "inset" }]]),
  );
  expect(channels).toHaveLength(3);
  const closed = windows.close();
  expect(channels[2]!.end).toHaveBeenCalledTimes(1);
  channels[2]!.finish();
  await closed;
});

test("a follower's server is observed by the host, and each read reaches only that server's followers", () => {
  const writes: Array<{ args: readonly string[]; write: jest.Mock }> = [];
  const windows = new WindowFollowers(
    {
      launchChannel: (opts: ChannelOpts) => {
        const write = jest.fn();
        writes.push({ args: opts.args ?? [], write });
        return { pid: 10, write, end: jest.fn(), ended: new Promise(() => {}) };
      },
    },
    { node: ["node"], bundle: "/test/dist/index.mjs", socket: "/host/socket" },
    heldClock(new Date(0)),
    jest.fn(),
    true,
  );
  const a = sessionIdOf("a"),
    b = sessionIdOf("b");
  const one = { socket: "/tmp/one", pane: "%1", truecolor: null };
  const two = { socket: "/tmp/two", pane: "%2", truecolor: null };
  expect(
    windows.declare(
      new Map([
        [a, { pane: one, placement: "inset" }],
        [b, { pane: two, placement: "inset" }],
      ]),
    ),
  ).toBe(true);
  expect([...windows.sockets()]).toEqual(["/tmp/one", "/tmp/two"]);
  expect(
    windows.declare(
      new Map([
        [a, { pane: one, placement: "docked" }],
        [b, { pane: two, placement: "inset" }],
      ]),
    ),
  ).toBe(false);
  for (const { write } of writes) write.mockClear();
  windows.tmuxRead("/tmp/one");
  const [first, second] = writes;
  expect(first!.args).toContain("/tmp/one");
  expect(first!.write.mock.calls).toEqual([['{"kind":"tmux"}\n']]);
  expect(second!.write).not.toHaveBeenCalled();
  expect(windows.declare(new Map())).toBe(true);
  expect([...windows.sockets()]).toEqual([]);
});
