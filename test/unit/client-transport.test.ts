// [LAW:behavior-not-structure] describeFailure is the operator-CLI rendering
// of a failed round-trip outcome. The load-bearing contract: the "daemon may
// not be running" spawn hint appears ONLY on transient failures — a permanent
// failure means the daemon is demonstrably up and answering, and suggesting a
// respawn would send the operator down the wrong path (the CLI analogue of
// the render path's kick-vs-no-kick split).

import {
  describeFailure,
  interpretException,
  interpretResponse,
  requestOutcome,
} from "../../src/daemon/client-transport";
import { HOME_ENV, NAME_ENV, homeOf } from "../../src/daemon/home";
import { socketPath } from "../../src/daemon/paths";
import { dialerFake, type DialerFake } from "../../src/dial/dialer-fake";
import { heldClock } from "../../src/held-clock";
import { hostOf } from "../helpers/host";
import type {
  PermanentOutcome,
  TransientOutcome,
} from "../../src/daemon/client-transport";
import {
  ClientTimeoutError,
  PROTOCOL_VERSION,
  type Response,
} from "../../src/daemon/protocol";

const HINT = "daemon may not be running";

// A daemon's own TIMEOUT proves it is up: a click's client must tell it from
// a wait it gave up itself, or it kicks a live daemon mid-click.
test("the daemon's TIMEOUT reads as busy, not as a client timeout", () => {
  const resp = {
    ok: false,
    error: "request exceeded 200ms",
    code: "TIMEOUT",
    daemonV: PROTOCOL_VERSION,
  } as Response;
  expect(interpretResponse("click", resp, () => undefined)).toEqual({
    kind: "busy",
    phase: "deadline",
    message: "request exceeded 200ms",
  });
});

// A dead daemon never times out (a missing socket is ENOENT, an unbound one
// ECONNREFUSED, both immediate), so a client timeout is a listener that has not
// answered: a kick's candidate would lose the bind to it. The classification is
// carried by the error's type and its phase, never by its message.
test.each(["connect", "deadline"] as const)(
  "a client %s timeout reads as busy in that phase, so nothing is kicked",
  (phase) => {
    const e = new ClientTimeoutError(phase);
    expect(interpretException(e)).toEqual({
      kind: "busy",
      phase,
      message: e.message,
    });
  },
);

test("a timeout is told by its type, so a reworded one still classifies and a lookalike string does not", () => {
  const reworded = Object.assign(new ClientTimeoutError("deadline"), {
    message: "gave up waiting",
  });
  expect(interpretException(reworded)).toMatchObject({ kind: "busy" });
  for (const message of ["TIMEOUT", "CONNECT_TIMEOUT"]) {
    expect(interpretException(new Error(message))).toMatchObject({
      kind: "transient",
    });
  }
});

// [LAW:parse-dont-validate] A connect's refusal is the dialer's to decide, so
// no message read after the connect names a cause: a refusal's words over an
// accepted connection are a broken connection.
test("an error over an accepted connection is io_error, whatever it says", () => {
  for (const code of ["ECONNREFUSED", "ENOENT", "EPIPE"]) {
    expect(interpretException(new Error(`write ${code}`))).toEqual({
      kind: "transient",
      cause: "io_error",
      message: `write ${code}`,
    });
  }
});

describe("a round trip's dial", () => {
  const clock = heldClock(new Date(0));
  const home = homeOf(hostOf({ [HOME_ENV]: "/fake-home", [NAME_ENV]: "rt" }));
  const world = (dialer: DialerFake) => ({
    host: hostOf({}),
    home,
    clock,
    dialer,
  });
  const ask = (dialer: DialerFake) =>
    requestOutcome(
      world(dialer),
      () => ({ kind: "stats" }),
      { connectMs: 50, budgetMs: 50 },
      () => 1,
    );

  test("no daemon at the socket is transient and unreachable, so a kick follows", async () => {
    const outcome = ask(dialerFake(clock));
    clock.advance(0);
    expect(await outcome).toMatchObject({
      kind: "transient",
      cause: "unreachable",
    });
  });

  test("a listener that never accepts is busy at connect, so nothing is kicked", async () => {
    const dialer = dialerFake(clock);
    dialer.hold(socketPath(home));
    const outcome = ask(dialer);
    clock.advance(50);
    expect(await outcome).toEqual({
      kind: "busy",
      phase: "connect",
      message: "CONNECT_TIMEOUT",
    });
  });
});

describe("describeFailure", () => {
  test("a busy daemon carries no spawn hint", () => {
    const text = describeFailure({
      kind: "busy",
      phase: "deadline",
      message: "x",
    });
    expect(text).not.toContain(HINT);
    expect(text).toContain("busy");
  });

  test("every transient cause a dead daemon explains carries the spawn hint", () => {
    const causes: Array<TransientOutcome["cause"]> = [
      "unreachable",
      "io_error",
    ];
    for (const cause of causes) {
      const text = describeFailure({ kind: "transient", cause, message: "x" });
      expect(text).toContain(HINT);
      expect(text).toContain(cause);
    }
  });

  test("no permanent cause carries the spawn hint", () => {
    const outcomes: PermanentOutcome[] = [
      { kind: "permanent", cause: "version_mismatch", clientV: 3, daemonV: 4 },
      { kind: "permanent", cause: "bad_request", message: "x" },
      { kind: "permanent", cause: "render_failed", message: "x" },
      { kind: "permanent", cause: "switched_off", message: "x" },
      { kind: "permanent", cause: "malformed_response", message: "x" },
    ];
    for (const outcome of outcomes) {
      expect(describeFailure(outcome)).not.toContain(HINT);
    }
  });

  test("version mismatch names both protocol versions", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: 3,
      daemonV: 4,
    });
    expect(text).toContain("client v3");
    expect(text).toContain("daemon v4");
  });

  test("an unechoed daemon version renders as unknown, not v0", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: 3,
      daemonV: 0,
    });
    expect(text).toContain("unknown");
    expect(text).not.toContain("v0");
  });

  test("message-bearing permanent causes surface the daemon's message", () => {
    const text = describeFailure({
      kind: "permanent",
      cause: "render_failed",
      message: "template exploded",
    });
    expect(text).toContain("render_failed");
    expect(text).toContain("template exploded");
  });
});
