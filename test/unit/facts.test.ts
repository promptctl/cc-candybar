import {
  parseFact,
  restamp,
  FactParseError,
  type AssertWire,
  type Fact,
} from "../../src/facts/fact";
import type { SessionFacts } from "../../src/facts/session-facts";
import type { GitInfo, PullRequest } from "../../src/segments/git";
import type { Current } from "../../src/utils/reading";
import { instantOf, type Instant } from "../../src/utils/instant";
import { ABSENT, failed, ok, pendingOf } from "../../src/utils/outcome";

const at = (seconds: number): Instant => instantOf(new Date(seconds * 1000));

// [LAW:types-are-the-program] The document crosses a process as JSON, so a
// value type that JSON would corrupt must not compile into it. These lines are
// the compile-time half of the contract: typecheck fails here, naming the type.
describe("what can cross as JSON", () => {
  const sessionFactsCross: AssertWire<SessionFacts> = true;
  // @ts-expect-error a Map becomes `{}`
  const mapDoesNot: AssertWire<{ sums: ReadonlyMap<string, number> }> = true;
  // @ts-expect-error a waiting reading carries a Promise
  const waitingDoesNot: AssertWire<{ pr: Current<PullRequest> }> = true;
  // @ts-expect-error a git read with the PR composed onto it is not the git fact
  const composedGitDoesNot: AssertWire<GitInfo> = true;

  it("holds for the whole facts document", () => {
    expect(sessionFactsCross).toBe(true);
    // The three above only exist to be refused.
    expect([mapDoesNot, waitingDoesNot, composedGitDoesNot]).toHaveLength(3);
  });
});

describe("restamp: at is the instant this answer first differed", () => {
  const found = (value: unknown) => ok(value);

  it("a first answer takes the instant", () => {
    expect(restamp(undefined, found(1), at(10))).toEqual({
      kind: "ok",
      value: 1,
      at: at(10),
    });
  });

  it("the same answer again keeps the prior fact, instant and all", () => {
    const prior = restamp(undefined, found({ a: 1, b: [2] }), at(10));
    // Another object, equal by structure, key order apart.
    const again = restamp(prior, found({ b: [2], a: 1 }), at(99));
    expect(again).toBe(prior);
  });

  it.each([
    ["a new value", found(2)],
    ["no value", ABSENT],
    ["a failure", failed("boom", "read")],
  ])("%s takes the new instant", (_name, next) => {
    const prior = restamp(undefined, found(1), at(10));
    expect(restamp(prior, next, at(20))).toMatchObject({ at: at(20) });
  });

  it("a failure with another reason, or in another phase, is a change", () => {
    const prior = restamp(undefined, failed("boom", "read"), at(10));
    expect(restamp(prior, failed("boom", "read"), at(20))).toBe(prior);
    expect(restamp(prior, failed("other", "read"), at(20))).toMatchObject({
      at: at(20),
    });
    expect(restamp(prior, failed("boom", "parse"), at(30))).toMatchObject({
      failedAt: "parse",
      at: at(30),
    });
  });

  it("pending comes out as the plain pending, and an answer after it takes the instant", () => {
    const waiting = {
      ...pendingOf("unread"),
      landed: new Promise<void>(() => {}),
      land: () => {},
    };
    const fact = restamp(undefined, waiting, at(10));
    expect(fact).toEqual({ kind: "pending", why: "unread" });
    expect(Object.keys(fact)).toEqual(["kind", "why"]);
    expect(restamp(fact, found(1), at(20))).toMatchObject({ at: at(20) });
    expect(
      restamp(restamp(fact, found(1), at(20)), pendingOf("unread"), at(30)),
    ).toEqual(pendingOf("unread"));
  });
});

describe("parseFact", () => {
  const through = (fact: unknown) =>
    parseFact(JSON.parse(JSON.stringify(fact)), "test");

  it.each<[string, Fact<unknown>]>([
    ["pending, unread", pendingOf("unread")],
    ["pending, superseded", pendingOf("superseded")],
    ["ok", { kind: "ok", value: { a: [1, "x", null, true] }, at: at(1) }],
    ["absent", { kind: "absent", at: at(2) }],
    [
      "failed in the read phase",
      { kind: "failed", reason: "no bytes", failedAt: "read", at: at(3) },
    ],
    [
      "failed in the parse phase",
      { kind: "failed", reason: "not json", failedAt: "parse", at: at(4) },
    ],
  ])("%s survives JSON as itself", (_name, fact) => {
    expect(through(fact)).toEqual(fact);
  });

  it.each([
    ["a string", "pending"],
    ["an array", []],
    ["an unknown kind", { kind: "later" }],
    ["a pending that gives no reason", { kind: "pending" }],
    ["a pending for a reason of its own", { kind: "pending", why: "asleep" }],
    ["an ok without an instant", { kind: "ok", value: 1 }],
    ["an ok whose instant is not finite", { kind: "ok", value: 1, at: null }],
    ["an ok whose value is not JSON", { kind: "ok", value: { n: NaN }, at: 1 }],
    ["a failure with no reason", { kind: "failed", failedAt: "read", at: 1 }],
    [
      "a failure in no phase",
      { kind: "failed", reason: "x", failedAt: "later", at: 1 },
    ],
  ])("refuses %s, loudly, naming where", (_name, json) => {
    expect(() => parseFact(json, "builtins.git")).toThrow(FactParseError);
    expect(() => parseFact(json, "builtins.git")).toThrow(/^builtins\.git: /);
  });

  // A source's own document can spell a pending. It is the ok arm's value
  // there, so it is a value, and the reading around it is still an ok.
  it("a document that spells pending is the value of an ok", () => {
    const spelled = { kind: "pending", why: "unread" };
    expect(through({ kind: "ok", value: spelled, at: at(5) })).toEqual({
      kind: "ok",
      value: spelled,
      at: at(5),
    });
  });
});
