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
import { WindowLayout } from "./layout.js";
import { clientKey, type Availability, type Client } from "./availability.js";
import { renderFailedFrame } from "../render/frame.js";
import {
  Presentation,
  readMessage,
  readNativeMessage,
  type NativeEvent,
  type Message,
} from "./presentation.js";
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
  const observations = new Map<string, Availability>();
  let watching = new Set<string>();
  let observedClients = "";
  let layoutIssue = "";
  let surfaceIssue = "";
  let sourceRetired = false;
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
  function publishStatus() {
    const reason = layoutIssue || surfaceIssue;
    if (status === reason) return;
    status = reason;
    process.stdout.write(JSON.stringify({ kind: "issue", reason }) + "\n");
  }
  const writeStatus = (reason: string) => {
    surfaceIssue = reason;
    publishStatus();
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
      native(readNativeMessage(line));
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
        const frame = !response.ok
          ? renderFailedFrame(response.error)
          : "frame" in response
            ? response.frame
            : undefined;
        if (!frame)
          throw new Error("Window subscription received a non-frame response");
        writeStatus(response.ok ? "" : response.error);
        displaying.offer(frame);
        const next = Math.max(1, frame.rows.length);
        if (height !== next) {
          height = next;
          if (placement === "inset") refresh();
        }
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
  function native(message: NativeEvent) {
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
      case "availability": {
        const observation = message;
        const key = clientKey(observation);
        if (watching.has(key)) {
          observations.set(key, observation);
          refresh();
        }
        break;
      }
      case "ready":
        if (!layoutIssue) {
          writeStatus("");
          subscribe();
        }
        break;
      case "hidden":
        unsubscribe();
        writeStatus("");
        break;
      case "unavailable":
        unsubscribe();
        writeStatus(String(message.reason));
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
              const result = await world.launcher.launch({
                bin: "/usr/bin/open",
                args: ["-u", url.href],
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
            observations,
          );
          if (requested !== placement || closed) continue;
          watching = new Set(next.clients.map(clientKey));
          for (const key of observations.keys())
            if (!watching.has(key)) observations.delete(key);
          const clients = JSON.stringify(next.clients);
          if (clients !== observedClients) {
            observedClients = clients;
            send({ kind: "clients", clients: next.clients });
          }
          if (next.selected) target = next.selected;
          else if (target && !watching.has(clientKey(target)))
            target = undefined;
          layoutIssue = next.issue ?? "";
          publishStatus();
          const encoded = JSON.stringify(next.layout);
          if (encoded !== appliedLayout) {
            send(next.layout);
            appliedLayout = encoded;
          }
          if (next.closed) {
            sourceRetired = true;
            stop();
          }
        } catch (error) {
          layoutIssue = String(error);
          publishStatus();
          unsubscribe();
          const hidden = { kind: "layout", placement: "hidden" };
          const encoded = JSON.stringify(hidden);
          if (encoded !== appliedLayout) send(hidden);
          appliedLayout = encoded;
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
      if (owned && !sourceRetired) await layout.clear();
    } finally {
      panel.end();
      await panelEnd;
      process.stdin.off("data", commands.push).pause();
    }
  }
  return 0;
}
