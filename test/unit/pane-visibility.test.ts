import {
  PaneVisibility,
  readServerView,
} from "../../src/daemon/pane-visibility";
import type { TmuxServerObserver } from "../../src/daemon/tmux-server-observer";

const hint = (socket: string, pane: string) => ({
  socket,
  pane,
  truecolor: null,
});

const snapshot = (pid: number, ...rows: string[]) =>
  [`B ${pid}`, ...rows, `E ${pid}`].join("\n");
const row = "P %1 $1 1 1 0 1 1 45 /dev/ttys001";

test("the snapshot shows attached current windows and every control-mode window, respecting zoom", () => {
  const panes = (...clients: string[]) =>
    readServerView(
      snapshot(
        7,
        "P %1 $1 1 1 0 1 1 41 /dev/tty1",
        "P %2 $1 1 1 0 0 1 42 /dev/tty2",
        "P %3 $1 1 0 0 1 1 43 /dev/tty3",
        "P %4 $2 0 1 0 1 1 44 /dev/tty4",
        "P %5 $3 2 1 1 1 1 45 /dev/tty5",
        "P %6 $3 2 1 1 0 1 46 /dev/tty6",
        ...clients,
      ),
    ).panes;
  const shown = (...clients: string[]) =>
    [...panes(...clients)].filter(([, pane]) => pane.shown).map(([id]) => id);
  expect(shown("C $1 0")).toEqual(["%1", "%2", "%5"]);
  expect(shown("C $1 1", "C $3 1")).toEqual(["%1", "%2", "%3", "%5"]);
});

test("linked panes are shown in the union of sessions; mouse describes visible clients", () => {
  const linked = "P %1 $2 1 0 0 1 0 45 /dev/ttys001";
  const panes = (...rows: string[]) =>
    readServerView(snapshot(7, ...rows)).panes.get("%1");
  expect(panes(row, linked)).toEqual({
    shown: true,
    zoomed: false,
    mouse: true,
    pid: 45,
    tty: "/dev/ttys001",
  });
  expect(panes(linked, row)).toEqual(panes(row, linked));
  expect(panes("C $2 1", linked, row)).toMatchObject({
    shown: true,
    mouse: false,
  });
});

test("a pane that runs no process is still a pane, so its window stays known", () => {
  // The window bar reserves its rows with an empty split: no pid, no tty.
  const view = readServerView(snapshot(7, row, "P %2 $1 1 1 0 0 1 - -"));
  expect(view.panes.get("%2")).toEqual({
    shown: true,
    zoomed: false,
    mouse: true,
    pid: null,
    tty: "-",
  });
  expect(view.panes.get("%1")?.shown).toBe(true);
});

test.each([
  "B 7\nP %1 $2 0 1 0 1 0 45 /dev/ttys001",
  "B 7\nE 8",
  snapshot(7, "P %1 $2 0 1 0"),
  snapshot(7, "C $2"),
  snapshot(7, row, row.replace("45", "46")),
])("incomplete or conflicting metadata cannot declare a pane gone", (raw) => {
  expect(() => readServerView(raw)).toThrow();
});

function harness() {
  type Events = Parameters<TmuxServerObserver["observe"]>[1];
  const registrations: Array<{
    socket: string;
    events: Events;
    close: jest.Mock;
  }> = [];
  const changed = jest.fn();
  const log = jest.fn();
  const visibility = new PaneVisibility(
    {
      observe(socket, events) {
        const close = jest.fn();
        registrations.push({ socket, events, close });
        return close;
      },
    },
    changed,
    log,
  );
  return { visibility, registrations, changed, log };
}

test("an observer belongs to each interested socket until it loses its last consumer", () => {
  const { visibility, registrations, changed } = harness();
  expect(visibility.shown(null)).toBe(true);
  visibility.reconcile(new Set(["/a", "/b"]));
  const [a, b] = registrations;
  expect(visibility.shown(hint("/a", "%2"))).toBe(true);
  a!.events.snapshot(snapshot(7, row));
  b!.events.snapshot(snapshot(8));
  expect(visibility.shown(hint("/a", "%1"))).toBe(true);
  expect(visibility.shown(hint("/a", "%2"))).toBe(false);
  expect(visibility.shown(hint("/b", "%1"))).toBe(false);
  a!.events.snapshot(snapshot(7, row));
  expect(changed).toHaveBeenCalledTimes(2);
  visibility.reconcile(new Set(["/a"]));
  expect(b!.close).toHaveBeenCalledTimes(1);
  b!.events.snapshot(snapshot(8, row));
  expect(changed).toHaveBeenCalledTimes(3);
  expect(a!.close).not.toHaveBeenCalled();
  expect(visibility.shown(hint("/b", "%1"))).toBe(true);
  visibility.reconcile(new Set());
  expect(a!.close).toHaveBeenCalledTimes(1);
});

test("loss publishes unknown, external interest reconnects; the old observer cannot publish", () => {
  const { visibility, registrations, changed } = harness();
  const wanted = new Set(["/a"]);
  visibility.reconcile(wanted);
  const previous = registrations[0]!;
  previous.events.snapshot(snapshot(7));
  previous.events.lost("server exited");
  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith("/a", null);
  expect(visibility.shown(hint("/a", "%1"))).toBe(true);
  visibility.reconcile(wanted);
  expect(registrations).toHaveLength(1);
  visibility.reconcile(wanted, "/a");
  previous.events.snapshot(snapshot(7));
  expect(changed).toHaveBeenCalledTimes(2);
  registrations[1]!.events.snapshot(snapshot(17, row));
  expect(changed.mock.lastCall?.[1].serverPid).toBe(17);
  previous.events.lost("old completion");
  expect(changed).toHaveBeenCalledTimes(3);
  expect(previous.close).toHaveBeenCalledTimes(1);
});

test("synchronous failure at registration retires the returned observer", () => {
  const close = jest.fn();
  const changed = jest.fn();
  const visibility = new PaneVisibility(
    {
      observe(_socket, events) {
        events.snapshot("B 7\n");
        return close;
      },
    },
    changed,
    jest.fn(),
  );
  visibility.reconcile(new Set(["/s"]));
  expect(close).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith("/s", null);
});
