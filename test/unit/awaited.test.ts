// [LAW:verifiable-goals] A request waits for what its frame would draw as
// pending: every key its renderer subscribes to, read the one way a draw reads
// it, so a key the document does not carry and a key it carries as unread are
// the same unread, for each kind of key.

import { awaitsReading, type SubscribedKeys } from "../../src/facts/awaited";
import { FACTS_VERSION } from "../../src/daemon/facts-assembly";
import {
  envFactOf,
  runFactOf,
  sourceFactOf,
  type WorldState,
} from "../../src/facts/world-state";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import { instantOf } from "../../src/utils/instant";
import { ABSENT, ok, pendingOf } from "../../src/utils/outcome";
import { daemonFactsOf } from "../helpers/daemon-facts";
import { NOTHING_SUBSCRIBED } from "../helpers/settled";

const AT = instantOf(new Date(1_700_000_000_000));

// A world state whose every built-in has answered, so only the keyed sources
// can be what a request waits on.
function worldStateOf(keyed: Partial<WorldState>): WorldState {
  const absent = { ...ABSENT, at: AT };
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
    ...keyed,
  };
}

const answered = { ...ok("x"), at: AT };

// Each kind of key: what subscribing to it says, what a document carrying its
// answer looks like, and how a draw reads it from a document that lacks it.
const KINDS: ReadonlyArray<
  readonly [
    string,
    SubscribedKeys,
    Partial<WorldState>,
    (w: WorldState) => unknown,
  ]
> = [
  [
    "a plugin source",
    { ...NOTHING_SUBSCRIBED, plugins: new Map([["p", null]]) },
    { sources: { p: answered } },
    (w) => sourceFactOf(w, "p"),
  ],
  [
    "a run",
    { ...NOTHING_SUBSCRIBED, runs: new Map([["digest", null]]) },
    { runs: { digest: { reading: answered, fault: null } } },
    (w) => runFactOf(w, "digest").reading,
  ],
  [
    "an env variable",
    { ...NOTHING_SUBSCRIBED, env: ["VAR"] },
    { env: { VAR: answered } },
    (w) => envFactOf(w, "VAR"),
  ],
];

describe("a request's wait over each kind of key", () => {
  test.each(KINDS)(
    "%s the document does not carry is waited for, as the draw reads it unread",
    (_, subscribed, _answered, drawn) => {
      const absent = worldStateOf({});
      expect(awaitsReading(absent, subscribed)).toBe(true);
      expect(drawn(absent)).toEqual(pendingOf("unread"));
    },
  );

  test.each(KINDS)(
    "%s the document carries answered is not waited for",
    (_, subscribed, carried) => {
      expect(awaitsReading(worldStateOf(carried), subscribed)).toBe(false);
    },
  );

  test("a key named like an inherited member is a key the document lacks", () => {
    const inherited = new Map([["constructor", null]]);
    for (const subscribed of [
      { ...NOTHING_SUBSCRIBED, plugins: inherited },
      { ...NOTHING_SUBSCRIBED, runs: inherited },
      { ...NOTHING_SUBSCRIBED, env: ["constructor"] },
    ])
      expect(awaitsReading(worldStateOf({}), subscribed)).toBe(true);
  });

  test("a key nothing subscribes to is not waited for", () => {
    expect(awaitsReading(worldStateOf({}), NOTHING_SUBSCRIBED)).toBe(false);
  });

  test("a key superseded is not a first answer still owed", () => {
    const superseded = { ...pendingOf("superseded"), at: AT };
    expect(
      awaitsReading(worldStateOf({ env: { VAR: superseded } }), {
        ...NOTHING_SUBSCRIBED,
        env: ["VAR"],
      }),
    ).toBe(false);
  });
});
