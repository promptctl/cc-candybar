// [LAW:behavior-not-structure] A single collector stamp crosses JSON to
// independent registries. Each reports what the variable currently shows,
// its age, and the raw error that an operator can already inspect.
import { SAMPLE_REGION } from "../scripts/lib/draw-fixtures/sample-region";
import {
  releasedDocuments,
  stampRun,
  stampRuns,
} from "../src/daemon/document-settlement";
import {
  environmentOutput,
  isEnvironmentOutput,
} from "../src/daemon/environment-output";
import { NOTHING_READ } from "../src/dsl/view-source";
import {
  UNREAD_RUN,
  type RunFact,
  type WorldState,
} from "../src/facts/world-state";
import { readingsAt } from "../src/utils/instant";
import { failed, ok, type Outcome } from "../src/utils/outcome";
import { pending as waiting, type Current } from "../src/utils/reading";
import { SourceRegistry, VariableStore } from "../src/var-system";
import type { JsonValue } from "../src/var-system/types";
import { heldClock } from "./helpers/held-clock";
import { feedInputs } from "./helpers/inputs";

const invalid = failed("incomplete JSON", "parse");

function fixture() {
  const clock = heldClock(new Date(10000));
  const stamp = (
    prior: RunFact | undefined,
    reading: Outcome<JsonValue>,
    documentRun = "file",
  ) =>
    stampRun(prior, { documentRun, reading, fault: null }, readingsAt(clock));
  const registries: SourceRegistry[] = [];
  const open = (initial: RunFact) => {
    const store = new VariableStore(clock);
    const registry = new SourceRegistry(store, SAMPLE_REGION);
    registries.push(registry);
    const offer = (fact: RunFact) => {
      const wire: RunFact = JSON.parse(JSON.stringify(fact));
      feedInputs(registry, { session_id: "s" }, undefined, {
        ...NOTHING_READ,
        run: () => wire,
      });
    };
    offer(initial);
    registry.declareFile("doc", "/source.json", {
      parse: { kind: "json", default: { text: "default" } },
      cache: { kind: "never" },
    });
    return {
      offer,
      shown: () => store.readDocument("doc"),
      changed: () => store.getNode("doc").lastUpdatedMs(),
      error: () => registry.getLastError("doc"),
    };
  };
  return {
    clock,
    stamp,
    open,
    close: () => registries.forEach((registry) => registry.dispose()),
  };
}

test("a fresh peer shares the held document, its age, the observed failure and the original expiry", () => {
  const { clock, stamp, open, close } = fixture();
  try {
    const good = stamp(undefined, ok({ text: "last good" }));
    const live = open(good);
    clock.advance(1000);
    const broken = stamp(good, invalid);
    live.offer(broken);
    clock.advance(50);
    const peer = open(broken);
    for (const view of [live, peer]) {
      expect(view.shown()).toEqual(ok({ text: "last good" }));
      expect(view.changed()).toBe(10000);
      expect(view.error()).toEqual({
        timestamp: 11000,
        message: "incomplete JSON",
      });
    }
    clock.advance(199);
    expect(stamp(broken, invalid)).toBe(broken);
    peer.offer(broken);
    expect(peer.shown()).toEqual(live.shown());
    clock.advance(1);
    const late = open(broken);
    for (const view of [live, peer, late]) {
      expect(view.shown()).toEqual(invalid);
      expect(view.changed()).toBe(11250);
    }
    // A distinct failure after expiry cannot bring back the old document.
    late.offer(stamp(broken, failed("still broken", "parse")));
    expect(late.shown()).toMatchObject({
      kind: "failed",
      reason: "still broken",
    });
  } finally {
    close();
  }
});

test("a repaired read cancels the pending failure on both peers and a fallback never starts a hold", () => {
  const { clock, stamp, open, close } = fixture();
  try {
    const good = stamp(undefined, ok({ text: "before" }));
    const broken = stamp(good, invalid);
    const live = open(broken);
    clock.advance(100);
    const peer = open(broken);
    const repaired = stamp(broken, ok({ text: "after" }));
    for (const view of [live, peer]) view.offer(repaired);
    clock.advance(400);
    for (const view of [live, peer]) {
      expect(view.shown()).toEqual(ok({ text: "after" }));
      expect(view.changed()).toBe(10100);
      expect(view.error()).toBeUndefined();
    }
    const absent = stamp(good, { kind: "absent" });
    const fallback = open(absent);
    expect(fallback.shown()).toEqual(ok({ text: "default" }));
    fallback.offer(stamp(absent, invalid));
    expect(fallback.shown()).toEqual(invalid);
  } finally {
    close();
  }
});

test("reacquiring a private document preserves its provenance and time only for its original environment", () => {
  const { clock, open, close } = fixture();
  const observed = (
    prior: RunFact | undefined,
    reading: Parameters<typeof stampRun>[1]["reading"],
    documentRun: string,
    privateValue: boolean,
  ) =>
    stampRun(
      prior,
      environmentOutput({ reading, documentRun, fault: null }, privateValue),
      readingsAt(clock),
    );
  try {
    const read = observed(undefined, ok({ text: "private" }), "original", true);
    clock.advance(100);
    const broken = observed(read, invalid, "original", true);
    const released = releasedDocuments({ file: broken }).file!;
    clock.advance(40);
    const pending = observed(released, waiting("unread"), "original", false);
    expect(pending.reading.kind).toBe("pending");
    expect(isEnvironmentOutput(pending)).toBe(true);
    const reboundView = open(pending);
    const newProducer = observed(
      released,
      waiting("unread"),
      "different",
      false,
    );
    reboundView.offer(newProducer);
    expect(reboundView.shown()).toEqual({ kind: "pending", why: "unread" });
    const peer = open(pending);
    expect(peer.shown()).toEqual(ok({ text: "private" }));
    peer.offer(observed(pending, invalid, "original", true));
    clock.advance(210);
    expect(peer.shown()).toEqual(invalid);
    expect(reboundView.shown()).toEqual({ kind: "pending", why: "unread" });
    const rebound = observed(released, invalid, "different", false);
    expect(isEnvironmentOutput(rebound)).toBe(false);
    expect(JSON.stringify(rebound)).not.toContain("private");
    expect(open(rebound).shown()).toEqual(invalid);
  } finally {
    close();
  }
});

test("two keyed declarations converge on one read and a fresh peer preserves each preceding document", () => {
  const clock = heldClock(new Date(0));
  let runs: WorldState["runs"] = {};
  let keys = { leftKey: "a", rightKey: "b" };
  const registries: SourceRegistry[] = [];
  const offer = (registry: SourceRegistry) => {
    const wire: WorldState["runs"] = JSON.parse(JSON.stringify(runs));
    feedInputs(registry, { session_id: "keyed", ...keys }, undefined, {
      ...NOTHING_READ,
      run: (digest) => wire[digest] ?? UNREAD_RUN,
    });
  };
  const open = () => {
    const store = new VariableStore(clock);
    const registry = new SourceRegistry(store, SAMPLE_REGION);
    registries.push(registry);
    offer(registry);
    for (const name of ["left", "right"]) {
      registry.declareInput(
        name + "Key",
        name + "Key",
        "string",
        undefined,
        "computed",
      );
      registry.declareFile(name, "/same.json", {
        cache: { kind: "key", template: "{{ ." + name + "Key }}" },
        parse: { kind: "json", default: undefined },
      });
    }
    return registry;
  };
  const publish = (
    registry: SourceRegistry,
    reading: (digest: string) => Current<JsonValue>,
  ) => {
    runs = stampRuns(
      runs,
      undefined,
      new Map(
        registry.subscriptions().map(({ run, documents }) => [
          run.digest,
          {
            documentRun: "same-file",
            documents,
            fault: null,
            reading: reading(run.digest),
          },
        ]),
      ),
      readingsAt(clock),
    );
    for (const view of registries) offer(view);
  };
  try {
    const origin = open();
    const left = origin.namedRuns().get("left")!.digest;
    publish(origin, (digest) =>
      ok({ text: digest === left ? "first left" : "first right" }),
    );
    clock.advance(100);
    keys = { leftKey: "merged", rightKey: "merged" };
    offer(origin);
    expect(origin.subscriptions()).toHaveLength(1);
    publish(origin, () => waiting("unread"));
    const duringRead = open();
    clock.advance(10);
    publish(origin, () => invalid);
    clock.advance(50);
    const duringFailure = open();
    for (const view of [origin, duringRead, duringFailure]) {
      expect(view.variableStore.readDocument("left")).toEqual(
        ok({ text: "first left" }),
      );
      expect(view.variableStore.readDocument("right")).toEqual(
        ok({ text: "first right" }),
      );
    }
    clock.advance(200);
    for (const view of registries) {
      expect(view.variableStore.readDocument("left")).toEqual(invalid);
      expect(view.variableStore.readDocument("right")).toEqual(invalid);
    }
    publish(origin, () => ok({ text: "one repaired reading" }));
    const repair = JSON.stringify(runs);
    expect(repair.split("one repaired reading")).toHaveLength(2);
    expect(repair).not.toContain("first left");
  } finally {
    for (const registry of registries) registry.dispose();
  }
});
