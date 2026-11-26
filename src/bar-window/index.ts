import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { WindowPlacement } from "../config/lanes.js";
import type { World } from "../host.js";
import { windowHelper } from "../install/window-runtime.js";
import { reportPointer } from "../bar-pane/report.js";
import { singleFlight } from "../bar-pane/single-flight.js";
import { ALL_GESTURES, HOVER } from "../click/gesture.js";
import { isBarLink } from "../click/wire.js";
import { socketPath, checkOwnedPrivateDir } from "../daemon/paths.js";
import { describeFailure } from "../daemon/client-transport.js";
import { tryClickViaDaemon, tryPointerViaDaemon } from "../daemon/client.js";
import { followFrames, type FrameFollower } from "../daemon/frame-follow.js";
import { parseSessionId } from "../daemon/foundations/session-id.js";
import { lineSplitter } from "../renderer-interface/wire.js";
import { whyFailed } from "../proc/launcher.js";
import { WindowLayout, type Client } from "./layout.js";
import { Presentation, readMessage, type Message } from "./presentation.js";
import { watchTmuxEvents } from "./tmux-events.js";

export async function runBarWindow(
  argv: readonly string[],
  bundle: string,
  world: World,
): Promise<number> {
  const [session, socket, pane, initial] = argv;
  if (
    argv.length !== 4 ||
    !parseSessionId(session).ok ||
    !session ||
    !socket ||
    !pane ||
    !/^%\d+$/.test(pane) ||
    (initial !== "docked" && initial !== "inset")
  )
    throw new Error(
      "usage: cc-candybar bar-window <session> <tmux-socket> <pane> <docked|inset>",
    );
  if (process.platform !== "darwin")
    throw new Error("The window surface requires macOS");
  const hostSocket = socketPath(world.host);
  const dir = path.dirname(hostSocket);
  checkOwnedPrivateDir(dir);
  const key = createHash("sha256")
    .update(JSON.stringify([hostSocket, session]))
    .digest("hex")
    .slice(0, 32);
  const layout = new WindowLayout(
    world.launcher,
    { socket, pane },
    `cc-candybar-window-${key}-${randomUUID()}`,
  );
  let placement: WindowPlacement = initial;
  let height = 1;
  let target: Client | undefined;
  let owned = false;
  let closed = false;
  let status: string | undefined;
  let feed: FrameFollower | undefined;
  let hover: string | null = null;
  const wire = { attached: false };
  let measured = false;
  const refused = new Set<number>();
  let appliedLayout = "";
  let refreshPending = false;
  let refreshing: Promise<void> | undefined;
  let watcher: ReturnType<typeof watchTmuxEvents> | undefined;
  let stopped!: () => void;
  const stopping = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const owner = randomUUID();
  const facts = () => ({
    id: owner,
    gestures: [...ALL_GESTURES, HOVER],
    hover,
  });
  const writeStatus = (reason: string) => {
    if (status === reason) return;
    status = reason;
    process.stdout.write(JSON.stringify({ kind: "issue", reason }) + "\n");
  };
  function stop() {
    if (!closed) {
      closed = true;
      stopped();
    }
  }
  function unsubscribe() {
    feed?.close();
    feed = undefined;
    wire.attached = false;
    hover = null;
  }
  const out = lineSplitter((line) => {
    try {
      native(readMessage(line));
    } catch (error) {
      writeStatus(String(error));
      stop();
    }
  });
  const panel = world.launcher.launchChannel({
    bin: windowHelper(bundle),
    args: [
      "panel",
      path.resolve(path.dirname(bundle), "../dist/bar-window/index.html"),
      path.join(dir, `window-${key}.lock`),
    ],
    category: "bar-window.panel",
    heard: { stdout: out.push, stderr: (text) => process.stderr.write(text) },
  });
  const send = (message: Message) =>
    panel.write(JSON.stringify(message) + "\n");
  const displaying = new Presentation(send);
  const panelEnd = panel.ended.then((result) => {
    out.end();
    if (!closed) {
      writeStatus(result.ok ? "Native window ended" : whyFailed(result));
      stop();
    }
  });
  const subscribe = () => {
    if (feed || closed) return;
    feed = followFrames(world, hostSocket, session, "window", {
      owner: facts,
      frame(response) {
        if (!wire.attached) {
          wire.attached = true;
          report();
        }
        if (response.ok && "frame" in response) {
          writeStatus("");
          displaying.offer(response.frame);
          const next = Math.max(1, response.frame.rows.length);
          if (height !== next) {
            height = next;
            if (placement === "inset") refresh();
          }
        } else if (!response.ok) writeStatus(response.error);
      },
      off: () => stop(),
      fault: (reason) => {
        wire.attached = false;
        writeStatus(reason);
      },
      exit: (reason) => {
        writeStatus(reason);
        stop();
      },
    });
  };
  let presses = Promise.resolve();
  const report = singleFlight(
    () =>
      reportPointer(
        { sessionId: session, wire },
        (sid, owned) => tryPointerViaDaemon(world, sid, owned),
        facts,
        writeStatus,
      ),
    (error) => {
      writeStatus(String(error));
      stop();
    },
  );
  function native(message: Message) {
    if (closed) return;
    switch (message.kind) {
      case "owned":
        owned = true;
        watcher = watchTmuxEvents(
          world,
          layout.target.socket,
          layout.reservationTitle,
          refresh,
          (reason) => {
            writeStatus(reason);
            stop();
          },
        );
        break;
      case "measured":
        measured = message.value === true;
        refresh();
        break;
      case "client-exit":
        measured = false;
        target = undefined;
        refresh();
        break;
      case "ready":
        if (target) refused.delete(target.pid);
        writeStatus("");
        subscribe();
        break;
      case "hidden":
        unsubscribe();
        writeStatus("");
        break;
      case "unavailable":
        unsubscribe();
        writeStatus(String(message.reason));
        if (target && !refused.has(target.pid)) {
          refused.add(target.pid);
          refresh();
        }
        break;
      case "presented":
        displaying.presented(message.revision);
        break;
      case "hover": {
        const next = displaying.run(message)?.region?.name ?? null;
        if (next === hover) break;
        hover = next;
        report();
        break;
      }
      case "press": {
        const link = displaying.link(message);
        if (!link || !wire.attached) break;
        presses = presses
          .then(async () => {
            if (isBarLink(link)) {
              const result = await tryClickViaDaemon(world, link);
              if (result.kind !== "ok") writeStatus(describeFailure(result));
            } else {
              const url = new URL(link);
              if (!["https:", "http:", "mailto:"].includes(url.protocol))
                throw new Error(
                  "Unsupported external link scheme " + url.protocol,
                );
              const result = await world.launcher.launch({
                bin: "/usr/bin/open",
                args: [url.href],
                category: "click.open",
                timeoutMs: 2000,
              });
              if (!result.ok) writeStatus(whyFailed(result));
            }
          })
          .catch((error) => writeStatus(String(error)));
        break;
      }
      default:
        throw new Error("Unknown native window event");
    }
  }
  function refresh() {
    refreshPending = true;
    if (refreshing || closed || !owned) return;
    refreshing = (async () => {
      while (refreshPending && !closed) {
        refreshPending = false;
        try {
          const requested = placement;
          const next = await layout.locate(
            requested,
            height,
            target,
            measured,
            refused,
          );
          if (requested !== placement) continue;
          if (closed) return;
          const client = next.clients[0];
          for (const pid of refused)
            if (!next.clients.some((item) => item.pid === pid))
              refused.delete(pid);
          if (
            client &&
            (client.pid !== target?.pid || client.tty !== target?.tty)
          ) {
            target = client;
            measured = false;
            send({ kind: "target", ...client });
          }
          const encoded = JSON.stringify(next.layout);
          if (encoded !== appliedLayout) {
            send(next.layout);
            appliedLayout = encoded;
          }
        } catch (error) {
          send({ kind: "layout", placement: "hidden" });
          appliedLayout = "";
          writeStatus(String(error));
        }
      }
    })().finally(() => {
      refreshing = undefined;
      if (refreshPending && !closed) refresh();
    });
  }
  const commands = lineSplitter((line) => {
    try {
      const message = readMessage(line);
      if (
        message.kind !== "placement" ||
        (message.value !== "inset" && message.value !== "docked")
      )
        throw new Error("Invalid host window placement");
      placement = message.value;
      refresh();
    } catch (error) {
      writeStatus(String(error));
      stop();
    }
  });
  process.stdin
    .setEncoding("utf8")
    .on("data", commands.push)
    .once("end", stop)
    .resume();
  try {
    await stopping;
  } finally {
    unsubscribe();
    try {
      await watcher?.close();
      await refreshing;
      if (owned) await layout.clear();
    } finally {
      panel.end();
      await panelEnd;
      process.stdin.off("data", commands.push).pause();
    }
  }
  return 0;
}
