import { startDaemon } from "./helpers/in-worker-daemon";
import { renderBody, configFlag } from "./helpers/daemon-e2e";
import { sendDaemonRequest } from "./helpers/daemon-wire";
import { prepareIsolatedDaemonEnv } from "./helpers/spawn-isolated-daemon";
import { hostHeld } from "./helpers/renderers";
import { renderFailedFrame } from "../src/render/frame";
import type { RendererPort } from "../src/daemon/renderer-process";
import { PROTOCOL_VERSION } from "../src/daemon/foundations/protocol";
import {
  type EffectId,
  type SessionConfig,
  type Subscriptions,
} from "../src/renderer-interface/interface";
import path from "node:path";

// [LAW:verifiable-goals] The feed's bounded request history and the
// collector's live sessions have different lifetimes. The replacement
// renderer needs the first session even after its feed history is evicted.
test("a renderer restart restores live sessions beyond the feed's request history", async () => {
  const { env, stateDir, removeTmpDirs } =
    prepareIsolatedDaemonEnv("ccb-restart");
  let startTurn: readonly SessionConfig[] = [];
  let restart: () => Promise<void> = async () => {
    throw new Error("the daemon did not attach a renderer");
  };
  const subscriptions: Subscriptions = {
    sources: {},
    lanes: {},
    managedFolders: [],
    configSelections: [],
    configs: [],
  };
  const renderer: RendererPort = () => ({
    start(own) {
      restart = own.start;
      return {
        renderer: hostHeld(
          {
            answer: async ({ event }) => {
              if (event.kind === "start") startTurn = event.sessions;
              return {
                kind: "answered",
                record: [],
                frames: [],
                stored: [],
                subscriptions,
                wake: null,
                ...(event.kind === "close-journal" || event.kind === "close-views"
                  ? { reply: { kind: event.kind } }
                  : {}),
                effects:
                  event.kind === "request"
                    ? [
                        {
                          kind: "present",
                          id: Number(event.id) as EffectId,
                          session: event.context.hookData.session_id,
                          surface: "statusline",
                          request: event.id,
                          frame: renderFailedFrame("test frame"),
                          awaiting: { kind: "settled", seq: 1 },
                        },
                      ]
                    : [],
              };
            },
          },
        ),
        serve: () => {},
        arm: () => {},
        restart: () => own.start(),
        beginClose: () => "closing",
        close: async () => {},
        process: () => null,
      };
    },
  });
  const daemon = startDaemon(env, { renderer });
  try {
    const first = "still-live";
    const selected = path.join(stateDir, "selected.json5");
    const ask = async (session: string, args: string[] = []): Promise<void> => {
      const reply = await sendDaemonRequest(
        daemon,
        {
          v: PROTOCOL_VERSION,
          kind: "render",
          ...renderBody(session, stateDir, {}, args),
        },
        5000,
      );
      if (!reply.ok)
        throw new Error(`${session}: ${reply.code} ${reply.error}`);
    };
    await ask(first, configFlag(selected));
    for (let n = 0; n < 256; n++) await ask(`later-${n}`);

    await restart();

    expect(startTurn).toHaveLength(257);
    const restored = startTurn.find(
      ({ worldState }) => worldState.session === first,
    );
    expect(restored).toMatchObject({
      context: {
        hookData: { session_id: first, location: expect.any(Object) },
        requested: { target: { source: "argument", path: selected } },
      },
      worldState: { session: first },
    });
    expect(restored?.context).not.toHaveProperty("env");
  } finally {
    await daemon.stop();
    removeTmpDirs();
  }
});
