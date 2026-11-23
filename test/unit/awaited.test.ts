// [LAW:verifiable-goals] A request waits for what its frame would draw as
// pending: every key its renderer subscribes to, read the one way a draw reads
// it, so a key the document does not carry and a key it carries as unread are
// the same unread, for each kind of key.

import { unreadOf } from "../../src/facts/awaited";
import { failedStamp } from "../../src/daemon/facts-assembly";
import type { Judged } from "../../src/daemon/foundations/judge-run";
import type { Subscribed } from "../../src/renderer-interface/request-context";
import {
  envFactOf,
  runFactOf,
  sourceFactOf,
  type WorldState,
} from "../../src/facts/world-state";
import { instantOf } from "../../src/utils/instant";
import { ok, pendingOf } from "../../src/utils/outcome";
import { NOTHING_SUBSCRIBED } from "../helpers/settled";
import { worldStateOf } from "../helpers/world-state";

const AT = instantOf(new Date(1_700_000_000_000));

const answered = { ...ok("x"), at: AT };

// What the rule reads of a subscribed run is its digest: the judgement is
// any one.
const JUDGED: Judged = { kind: "refused", digest: "digest", reason: "-" };

// Each kind of key: what subscribing to it says, what a document carrying its
// answer looks like, and how a draw reads it from a document that lacks it.
const KINDS: ReadonlyArray<
  readonly [
    string,
    Subscribed,
    Partial<WorldState>,
    (w: WorldState) => unknown,
  ]
> = [
  [
    "a plugin source",
    { ...NOTHING_SUBSCRIBED, plugins: new Map([["p", "/p"]]) },
    { sources: { p: answered } },
    (w) => sourceFactOf(w, "p"),
  ],
  [
    "a run",
    { ...NOTHING_SUBSCRIBED, runs: new Map([["digest", JUDGED]]) },
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
      expect(unreadOf(absent, subscribed)).toHaveLength(1);
      expect(drawn(absent)).toEqual(pendingOf("unread"));
    },
  );

  test.each(KINDS)(
    "%s the document carries answered is not waited for",
    (_, subscribed, carried) => {
      expect(unreadOf(worldStateOf(carried), subscribed)).toEqual([]);
    },
  );

  test("a key named like an inherited member is a key the document lacks", () => {
    for (const subscribed of [
      { ...NOTHING_SUBSCRIBED, plugins: new Map([["constructor", "/p"]]) },
      { ...NOTHING_SUBSCRIBED, runs: new Map([["constructor", JUDGED]]) },
      { ...NOTHING_SUBSCRIBED, env: ["constructor"] },
    ])
      expect(unreadOf(worldStateOf({}), subscribed)).toHaveLength(1);
  });

  test("a key nothing subscribes to is not waited for", () => {
    expect(unreadOf(worldStateOf({}), NOTHING_SUBSCRIBED)).toEqual([]);
  });

  test("a key superseded is not a first answer still owed", () => {
    const superseded = { ...pendingOf("superseded"), at: AT };
    expect(
      unreadOf(worldStateOf({ env: { VAR: superseded } }), {
        ...NOTHING_SUBSCRIBED,
        env: ["VAR"],
      }),
    ).toEqual([]);
  });

  test.each(KINDS)(
    "%s the document lacks, once its stamp has failed, is that failure the draw reads and no wait",
    (_, subscribed, _carried, drawn) => {
      const lacking = worldStateOf({});
      const failed = failedStamp(
        lacking,
        "reading the owners: boom",
        lacking.daemon,
        subscribed,
        AT,
      );
      expect(unreadOf(failed, subscribed)).toEqual([]);
      expect(drawn(failed)).toMatchObject({
        kind: "failed",
        reason: "reading the owners: boom",
      });
    },
  );
});
