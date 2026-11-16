// A test's host for config writes: each lands through the host's own
// interpreter (src/daemon/effect-interpreter.ts), in place, so a test's
// writes splice and refuse exactly as the daemon's do.

import { diffChanges, type Change } from "../../src/config/config-changes";
import { userLayerPath } from "../../src/config/loader/discovery";
import { configInterpreter } from "../../src/daemon/effect-interpreter";
import { parseRenderOrigin } from "../../src/renderer/verbs";
import { SESSION_RENDER_ORIGIN_KEY } from "../../src/daemon/foundations/session-keys";
import type { SessionId } from "../../src/daemon/foundations/session-id";
import type { Locations } from "../../src/config/loader/discovery";
import type { EffectId } from "../../src/renderer-interface/interface";
import type { SessionStateReader } from "../../src/renderer-interface/session-state";
import type { EditStore, FileLand } from "../../src/renderer/config-file-store";
import type { Land } from "../../src/renderer/landings";

const TEST_SESSION = "test-session" as SessionId;

const landTo = (
  file: (session: SessionId) => string | null,
  session: SessionId,
  changes: readonly Change[],
) =>
  configInterpreter({ userLayer: file, log: () => {} }).change({
    kind: "change",
    id: 0 as EffectId,
    session,
    target: { kind: "layer", role: "user" },
    changes,
  });

// The text of `file` moving from `before` to `after`, landed in place.
export const landInPlace: FileLand = async (file, before, after) =>
  landTo(() => file, TEST_SESSION, diffChanges(before, after));

// A store whose writes land in place and are recorded nowhere.
export const STORE_IN_PLACE: EditStore = { land: landInPlace };

// [LAW:one-source-of-truth] A click's landing as the host performs it: to the
// user layer of the session's recorded render, as the host finds it from the
// newest request it holds.
export function landForSessions(
  sessionState: SessionStateReader,
  locs: Locations,
): Land {
  return async (session, changes) =>
    landTo(
      (sid) => {
        const raw = sessionState.get(sid, SESSION_RENDER_ORIGIN_KEY);
        return raw === null
          ? null
          : userLayerPath(locs, parseRenderOrigin(raw).target.path);
      },
      session,
      changes,
    );
}
