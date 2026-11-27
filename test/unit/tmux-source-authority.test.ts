import {
  TmuxSourceAuthority,
  type SourceClaim,
  type SourceEdges,
} from "../../src/daemon/tmux-source-authority";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { foregroundMembers } from "../../src/daemon/tmux-source-edge";

const source = { socket: "/private/one", pane: "%0", truecolor: null };
const other = { ...source, socket: "/private/two" };
const process = { pid: 51, tty: "/dev/pts/8" };
const view = (pid: number, p = process) => ({
  serverPid: pid,
  panes: new Map([["%0", p]]),
});
const A = sessionIdOf("old"),
  B = sessionIdOf("cleared"),
  TOOL = sessionIdOf("tool");

function fixture() {
  let sid = A;
  const listeners = new Set<() => void>();
  const confirmed = jest.fn();
  const log = jest.fn();
  const inspected: SourceClaim[][] = [];
  const inspect: SourceEdges["inspect"] = async (pane, claims, watch) => {
    inspected.push([...claims]);
    watch(["record"]);
    const claim = claims.find(
      (c) =>
        c.sid === sid &&
        (c.parentPid === undefined || c.parentPid === pane.pid),
    );
    return claim
      ? { kind: "confirmed", sid: claim.sid }
      : { kind: "unknown", reason: "no matching candidate" };
  };
  const deps: SourceEdges = {
    inspect,
    watch: (_file, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const authority = new TmuxSourceAuthority({ ...deps, confirmed, log });
  const replace = (next: typeof A) => {
    sid = next;
    for (const l of listeners) l();
  };
  return { authority, confirmed, log, replace, listeners, inspected, deps };
}

test.each(["request first", "record first"])(
  "a genuine clear survives unrelated claims with %s",
  async (order) => {
    const {
      authority: a,
      confirmed,
      replace,
      listeners,
      inspected,
    } = fixture();
    a.report(source, A, undefined, "/claude"); // Already shipped client, cold saved preference.
    a.observed(source.socket, view(100));
    await a.report(source, A, undefined, "/claude");
    expect(a.session(source)).toBe(A);
    expect(listeners.size).toBe(0);
    a.report(source, TOOL, 91, "/claude");
    await a.report(source, A, 91, "/claude");
    if (order === "record first") replace(B);
    a.report(source, B, 51, "/claude");
    await a.report(source, TOOL, undefined, "/claude");
    if (order === "request first") {
      expect(a.session(source)).toBe(A);
      replace(B); // No new render.
    }
    await a.report(source, B, 51, "/claude");
    expect(confirmed.mock.calls).toEqual([
      [source, A, 100],
      [source, B, 100],
    ]);
    const before = inspected.length;
    a.report(source, B, 51, "/claude");
    a.observed(source.socket, view(100));
    expect(inspected).toHaveLength(before);
    a.release(source);
    expect(listeners.size).toBe(0);
    expect(a.session(source)).toBeNull();
  },
);

test("a new server, changed pane root or retired observer invalidates an outstanding lookup", async () => {
  const reads: ReturnType<
    typeof Promise.withResolvers<Awaited<ReturnType<SourceEdges["inspect"]>>>
  >[] = [];
  const second = Promise.withResolvers<void>();
  const confirmed = jest.fn();
  const a = new TmuxSourceAuthority({
    confirmed,
    log: jest.fn(),
    watch: () => () => {},
    inspect: async () => {
      const result =
        Promise.withResolvers<Awaited<ReturnType<SourceEdges["inspect"]>>>();
      reads.push(result);
      if (reads.length === 2) second.resolve();
      return result.promise;
    },
  });
  a.observed(source.socket, view(1));
  const accepted = a.report(source, A, undefined, "/c");
  a.observed(source.socket, null);
  a.observed(source.socket, view(2));
  reads[0]!.resolve({ kind: "confirmed", sid: A });
  await second.promise;
  expect(confirmed).not.toHaveBeenCalled();
  reads[1]!.resolve({ kind: "confirmed", sid: A });
  await accepted;
  expect(confirmed.mock.calls).toEqual([[source, A, 2]]);
  a.observed(other.socket, view(2));
  expect(a.session(other)).toBeNull();
  a.observed(source.socket, view(2, { pid: 88, tty: "/dev/pts/9" }));
  expect(confirmed.mock.calls.at(-1)).toEqual([source, null, 2]);
  const interrupted = a.report(source, A, undefined, "/c");
  a.close();
  reads[2]!.resolve({ kind: "confirmed", sid: B });
  await interrupted;
  expect(a.session(source)).toBeNull();
});

test("only foreground descendants on the full source tty can own the pane", () => {
  const row = (pid: number, parent: number, grp: number, tty = "pts/8") =>
    `${pid} ${parent} ${grp} 62 ${tty} Fri Nov 27 03:53:47 2026`;
  const listing = [
    row(51, 1, 51),
    row(62, 51, 62),
    row(63, 62, 62),
    row(64, 62, 65),
    row(65, 62, 62, "pts/18"),
    row(66, 1, 62),
  ].join("\n");
  expect(foregroundMembers(process, listing).map((x) => x.pid)).toEqual([
    62, 63,
  ]);
  expect(() =>
    foregroundMembers({ pid: 51, tty: "/dev/pts/18" }, listing),
  ).toThrow("no matching foreground tty");
});

test("candidate interest survives unknown topology but ends on positive removal or release", async () => {
  const { authority: a } = fixture();
  a.observed(source.socket, view(1));
  await a.report(source, A, undefined, "/c");
  expect([...a.candidates(source)]).toEqual([A]);
  a.observed(source.socket, null);
  expect([...a.candidates(source)]).toEqual([A]);
  a.observed(source.socket, { serverPid: 1, panes: new Map() });
  expect([...a.candidates(source)]).toEqual([]);
  a.release(source);
  a.observed(source.socket, view(2));
  expect([...a.candidates(source)]).toEqual([]);
});

test("a retry checks its own claim even when another invocation already established the same session", async () => {
  const { authority: a, inspected } = fixture();
  a.observed(source.socket, view(100));
  const claim = { sid: A, parentPid: process.pid, configDir: "/claude" };
  await a.report(source, claim.sid, claim.parentPid, claim.configDir);
  expect(a.session(source)).toBe(A);
  expect(await a.verifies(source, { ...claim, parentPid: 99 })).toBe(false);
  expect(inspected.at(-1)).toEqual([{ ...claim, parentPid: 99 }]);
  expect(await a.verifies(source, claim)).toBe(true);
  expect(await a.verifies(source, { ...claim, parentPid: undefined })).toBe(
    true,
  );
  a.release(source);
  expect(await a.verifies(source, claim)).toBe(false);
});
