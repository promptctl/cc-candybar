// [LAW:parse-dont-validate] A recording's text crosses one unit into typed
// lines: a line that is not one is refused naming its number, a document of
// another version is refused, and what the recorder writes reads back as
// itself.

import { restamp } from "../../src/facts/fact";
import {
  formatLine,
  parseRecording,
  parseSessionFacts,
  type FactsLine,
} from "../../src/facts/recording";
import { FACTS_VERSION } from "../../src/facts/session-facts";
import { sessionIdOf } from "../../src/daemon/session-id";
import { instantOf } from "../../src/utils/instant";
import { ok } from "../../src/utils/outcome";
import { pendingFacts } from "../helpers/facts";

const SESSION = sessionIdOf("rec-session");
const AT = instantOf(new Date(1_700_000_000_000));

// A document with a few answered facts beside the pending ones.
function document(seq: number): FactsLine["facts"] {
  const pending = pendingFacts(SESSION);
  return {
    ...pending,
    seq,
    builtins: {
      ...pending.builtins,
      git: restamp(
        undefined,
        ok({
          branch: "main",
          status: "clean",
          aheadBehind: ok({ ahead: 0, behind: 0 }),
          head: ok("c0ffee"),
        }),
        AT,
      ),
      hostName: restamp(undefined, ok("box"), AT),
    },
    sources: { "plugins.p.status": restamp(undefined, ok({ home: "/h" }), AT) },
    diagnostics: [{ lane: "session", reason: "transcript unreadable" }],
  };
}

test("what the recorder writes reads back as itself", () => {
  const lines: FactsLine[] = [
    { at: AT, facts: document(1) },
    { at: (AT + 1.5) as typeof AT, facts: document(2) },
  ];
  const text = lines.map(formatLine).join("");
  expect(parseRecording(text)).toEqual(lines);
});

test("a line that is not JSON, or not a line, is refused by its number", () => {
  const good = formatLine({ at: AT, facts: document(1) });
  expect(() => parseRecording(`${good}{not json\n`)).toThrow(
    /^line 2: is not JSON/,
  );
  expect(() => parseRecording(`${good}${good}[1,2]\n`)).toThrow(
    /^line 3: is not an object/,
  );
  expect(() =>
    parseRecording(`${JSON.stringify({ facts: document(1) })}\n`),
  ).toThrow(/^line 1: has no finite `at`/);
});

test("a partial document is refused naming the field", () => {
  const facts = document(1) as unknown as Record<string, unknown>;
  const { builtins: _builtins, ...withoutBuiltins } = facts;
  expect(() =>
    parseRecording(`${JSON.stringify({ at: AT, facts: withoutBuiltins })}\n`),
  ).toThrow(/^line 1: has no `builtins`/);
  const broken = {
    ...facts,
    builtins: { ...(facts.builtins as object), git: { kind: "ok", value: 1 } },
  };
  expect(() =>
    parseRecording(`${JSON.stringify({ at: AT, facts: broken })}\n`),
  ).toThrow(/^line 1 builtins.git: has no finite `at`/);
});

test("a document of another facts version is refused", () => {
  const other = { ...document(1), v: FACTS_VERSION + 1 };
  expect(() => parseSessionFacts(other, "line 1")).toThrow(
    new RegExp(
      `^line 1: is facts version ${FACTS_VERSION + 1}, and this build reads ${FACTS_VERSION}`,
    ),
  );
});

test("a pending that crossed as JSON is a pending, not a value", () => {
  const parsed = parseSessionFacts(
    JSON.parse(JSON.stringify(document(1))),
    "line 1",
  );
  expect(parsed.builtins.session).toEqual({ kind: "pending", why: "unread" });
  expect(parsed.builtins.git.kind).toBe("ok");
});
