import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import type { WorldState } from "../../src/facts/world-state";
import { instantOf } from "../../src/utils/instant";
import { ABSENT } from "../../src/utils/outcome";
import { daemonFactsOf } from "./daemon-facts";

// A world state whose every built-in has answered (as absent), so only what
// `over` carries can be what a request waits on.
export function worldStateOf(over: Partial<WorldState> = {}): WorldState {
  const absent = { ...ABSENT, at: instantOf(new Date(1_700_000_000_000)) };
  return {
    v: FACTS_VERSION,
    session: sessionIdOf("s"),
    seq: 1,
    builtins: {
      session: absent,
      today: absent,
      speed: absent,
      context: absent,
      metrics: absent,
      activity: absent,
      cache: absent,
      autocompact: absent,
      git: absent,
      pr: absent,
      tmux: absent,
      hostName: absent,
      hostUser: absent,
    },
    sources: {},
    runs: {},
    env: {},
    daemon: daemonFactsOf(),
    diagnostics: [],
    ...over,
  };
}
