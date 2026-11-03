import { pendingOf } from "../../src/utils/outcome";
import { found, resolvePath } from "../../src/var-system/sources";

// [LAW:parse-dont-validate] A path through a view's payload finds a value or a
// source that has not answered. A source's own JSON can spell anything, so
// what it spells is a value, never the daemon's pending.
describe("resolvePath", () => {
  it("finds a leaf, and nothing for a path the payload does not have", () => {
    const payload = { session: { cost: 3 } };
    expect(resolvePath(payload, "session.cost")).toEqual(found(3));
    expect(resolvePath(payload, "session.tokens")).toEqual(found(undefined));
    expect(resolvePath(payload, "session.cost.cents")).toEqual(
      found(undefined),
    );
  });

  it("a source that has not answered is every path through it, and itself", () => {
    const payload = { git: pendingOf("superseded") };
    expect(resolvePath(payload, "git")).toEqual(pendingOf("superseded"));
    expect(resolvePath(payload, "git.branch")).toEqual(pendingOf("superseded"));
    expect(resolvePath(payload, "git.pr.number")).toEqual(
      pendingOf("superseded"),
    );
  });

  it("a document that spells pending is a value, at its root and below it", () => {
    const spelled = { kind: "pending", why: "unread" };
    const payload = { feed: { kind: "ok", value: spelled } };
    expect(resolvePath(payload, "feed.value")).toEqual(found(spelled));
    expect(resolvePath(payload, "feed.value.kind")).toEqual(found("pending"));
    expect(resolvePath(payload, "feed.value.why")).toEqual(found("unread"));
    // Nothing is below a string: not answered is not the same as not there.
    expect(resolvePath(payload, "feed.value.why.length")).toEqual(
      found(undefined),
    );
  });

  it("a document nested in a document is still a document", () => {
    const payload = {
      feed: {
        kind: "ok",
        value: { inner: { kind: "pending", why: "unread" } },
      },
    };
    expect(resolvePath(payload, "feed.value.inner.why")).toEqual(
      found("unread"),
    );
  });
});
