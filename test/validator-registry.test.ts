// [LAW:single-enforcer] A gate is derived from ONE config: whether two
// contributions may share a key is decided by mergeKeySpecs among that config's
// own actions (and the daemon-wide keys), never across the configs the daemon
// happens to hold at once (brandon-state-gates-lbs). Driven through the generic
// keyspace with a config that is nothing but its contributions, so each case
// states exactly what a config declares.

import {
  createKeyspace,
  type KeySpecContribution,
} from "../src/daemon/verbs/validator-registry";

interface Declares {
  readonly contributions: readonly KeySpecContribution[];
}

const declares = (...contributions: KeySpecContribution[]): Declares => ({
  contributions,
});

const keyspace = (
  baseline: Parameters<typeof createKeyspace>[0] = {},
  noun = "config",
) => createKeyspace<Declares>(baseline, noun, (c) => c.contributions);

describe("two configs declaring one key", () => {
  test("different ranges: each config's sessions are gated and bounded by their own", () => {
    const ks = keyspace();
    const narrow = declares({
      key: "width",
      spec: { kind: "range", min: 1, max: 3 },
    });
    const wide = declares({
      key: "width",
      spec: { kind: "range", min: 1, max: 9 },
    });
    // Both gates built, in either order: neither widens the other.
    const wideGate = ks.gateFor(wide);
    const narrowGate = ks.gateFor(narrow);
    expect(narrowGate.rangeParamsFor("width")).toEqual({ min: 1, max: 3 });
    expect(wideGate.rangeParamsFor("width")).toEqual({ min: 1, max: 9 });
    expect(narrowGate.validate("width", "7")).toEqual({ ok: true, value: "3" });
    expect(wideGate.validate("width", "7")).toEqual({ ok: true, value: "7" });
  });

  test("a word list in one and a range in the other: both gate, neither throws", () => {
    const ks = keyspace();
    const words = declares({
      key: "width",
      spec: { kind: "allow-list", allowed: ["narrow", "wide"] },
    });
    const range = declares({
      key: "width",
      spec: { kind: "range", min: 1, max: 9 },
    });
    const wordGate = ks.gateFor(words);
    const rangeGate = ks.gateFor(range);
    expect(wordGate.validate("width", "wide")).toEqual({
      ok: true,
      value: "wide",
    });
    expect(wordGate.validate("width", "4").ok).toBe(false);
    expect(wordGate.rangeParamsFor("width")).toBeNull();
    expect(rangeGate.validate("width", "4")).toEqual({ ok: true, value: "4" });
    expect(rangeGate.validate("width", "wide").ok).toBe(false);
  });

  test("a key only one config declares is unknown to the other's sessions", () => {
    const ks = keyspace();
    const has = declares({
      key: "mode",
      spec: { kind: "allow-list", allowed: ["full"] },
    });
    expect(ks.gateFor(has).listKeys()).toEqual(["mode"]);
    const other = ks.gateFor(declares());
    expect(other.listKeys()).toEqual([]);
    const refused = other.validate("mode", "full");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toMatch(/unknown config key "mode"/);
  });
});

describe("one config's own contributions", () => {
  test("an empty allow-list and a range coexist, gated by the range", () => {
    // Every config's settings menu makes `padding` a clearable key (an empty
    // allow-list) while a user's own `persist` stepper makes it a range.
    const gate = keyspace().gateFor(
      declares(
        { key: "padding", spec: { kind: "allow-list", allowed: [] } },
        { key: "padding", spec: { kind: "range", min: 0, max: 16 } },
      ),
    );
    expect(gate.rangeParamsFor("padding")).toEqual({ min: 0, max: 16 });
    expect(gate.validate("padding", "4")).toMatchObject({ ok: true });
    expect(gate.validate("padding", "40")).toEqual({ ok: true, value: "16" });
    expect(gate.validate("padding", "wide").ok).toBe(false);
  });

  test("an incoherent pair is refused when the gate is built", () => {
    const ks = keyspace();
    expect(() =>
      ks.gateFor(
        declares(
          { key: "padding", spec: { kind: "range", min: 0, max: 16 } },
          { key: "padding", spec: { kind: "allow-list", allowed: ["wide"] } },
        ),
      ),
    ).toThrow(/non-integer/);
  });

  test("a built-in key re-claimed, an empty key and a slash-bearing key are refused", () => {
    const ks = keyspace({ theme: (raw) => ({ ok: true, value: raw }) }, "state");
    expect(() =>
      ks.gateFor(declares({ key: "theme", spec: { kind: "int" } })),
    ).toThrow(/"theme" is a built-in state key/);
    expect(() =>
      ks.gateFor(declares({ key: "", spec: { kind: "int" } })),
    ).toThrow(/key is required/);
    expect(() =>
      ks.gateFor(declares({ key: "a/b", spec: { kind: "int" } })),
    ).toThrow(/contains "\/"/);
  });

  test("a config's gate is derived once, and again for the object a reload makes", () => {
    let derived = 0;
    const ks = createKeyspace<Declares>({}, "config", (c) => {
      derived++;
      return c.contributions;
    });
    const config = declares({ key: "mode", spec: { kind: "int" } });
    expect(ks.gateFor(config)).toBe(ks.gateFor(config));
    expect(derived).toBe(1);
    ks.gateFor(declares(...config.contributions));
    expect(derived).toBe(2);
  });
});

describe("a daemon-wide key", () => {
  test("is writable in every config's sessions until it is disposed", () => {
    const ks = keyspace();
    const a = declares({ key: "mode", spec: { kind: "int" } });
    const b = declares();
    const dispose = ks.register("update.dismissed", ["1.2.3"]);
    for (const config of [a, b]) {
      expect(ks.gateFor(config).validate("update.dismissed", "1.2.3").ok).toBe(
        true,
      );
    }
    dispose();
    for (const config of [a, b]) {
      expect(ks.gateFor(config).listKeys()).not.toContain("update.dismissed");
    }
    // A config's own key is untouched by either.
    expect(ks.gateFor(a).validate("mode", "4").ok).toBe(true);
  });

  test("unions with a config's own contribution to the same key", () => {
    const ks = keyspace();
    const config = declares({
      key: "updateNotice",
      spec: { kind: "allow-list", allowed: ["true"] },
    });
    const dispose = ks.register("updateNotice", ["false"]);
    const gate = ks.gateFor(config);
    expect(gate.validate("updateNotice", "true").ok).toBe(true);
    expect(gate.validate("updateNotice", "false").ok).toBe(true);
    dispose();
    expect(ks.gateFor(config).validate("updateNotice", "false").ok).toBe(false);
  });

  test("two registrations of one key union, and each disposer removes only its own", () => {
    const ks = keyspace();
    const bare = declares();
    const disposeRed = ks.register("mode", ["red"]);
    const disposeBlue = ks.register("mode", ["blue"]);
    expect(ks.gateFor(bare).validate("mode", "red").ok).toBe(true);
    expect(ks.gateFor(bare).validate("mode", "blue").ok).toBe(true);
    disposeRed();
    // A second call removes nothing more.
    disposeRed();
    expect(ks.gateFor(bare).validate("mode", "red").ok).toBe(false);
    expect(ks.gateFor(bare).validate("mode", "blue").ok).toBe(true);
    disposeBlue();
    expect(ks.gateFor(bare).listKeys()).toEqual([]);
  });

  test("a registration that cannot gate throws and leaves the keyspace as it was", () => {
    const ks = keyspace({ theme: (raw) => ({ ok: true, value: raw }) }, "state");
    const bare = declares();
    const dispose = ks.register("mode", ["red"]);
    expect(() => ks.register("theme", ["x"])).toThrow(/built-in state key/);
    expect(() => ks.register("", ["x"])).toThrow(/key is required/);
    expect(() => ks.register("a/b", ["x"])).toThrow(/contains "\/"/);
    expect(ks.gateFor(bare).listKeys()).toEqual(["theme", "mode"]);
    expect(ks.gateFor(bare).validate("mode", "red").ok).toBe(true);
    dispose();
  });

  // The members of a daemon-wide key change while configs stay loaded (the
  // update notice's dismissal gains its identity when a newer build appears),
  // so the refusal cannot wait for a member that contradicts the config.
  test("a config giving it another shape is refused while it holds no member", () => {
    const ks = keyspace({}, "state");
    ks.register("update.dismissed", []);
    for (const spec of [
      { kind: "int" },
      { kind: "range", min: 0, max: 3 },
    ] as const) {
      expect(() =>
        ks.gateFor(declares({ key: "update.dismissed", spec })),
      ).toThrow(/key "update.dismissed" is written by the daemon's own links/);
    }
    // A config's own values join the list, and a later member cannot clash.
    const words = declares({
      key: "update.dismissed",
      spec: { kind: "allow-list", allowed: ["mine"] },
    });
    expect(ks.gateFor(words).validate("update.dismissed", "mine").ok).toBe(true);
    ks.register("update.dismissed", ["1.2.3"]);
    expect(ks.gateFor(words).validate("update.dismissed", "1.2.3").ok).toBe(
      true,
    );
  });
});
