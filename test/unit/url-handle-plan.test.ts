// [LAW:behavior-not-structure] What url-handle tells its reader when the daemon
// did not answer a click with its outcome. The exit code is the handler app's
// error dialog and the text is what a person reads, so together they must say
// what became of the click: refused unread (ran nothing, click again), never
// sent (the same), or cut off by the client's own clock (unknown, claiming
// neither result, since a second click on one that ran can revert it).

import { urlHandlePlan } from "../../src/install/index";

describe("urlHandlePlan on a busy daemon", () => {
  test("a connect timeout never delivered the click: it ran nothing, so click again", () => {
    expect(
      urlHandlePlan({
        kind: "busy",
        phase: "connect",
        message: "CONNECT_TIMEOUT",
      }),
    ).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/ran nothing; click again/),
    });
  });

  test("the daemon's own TIMEOUT refused the click unread: it ran nothing, so click again", () => {
    const plan = urlHandlePlan({
      kind: "busy",
      phase: "backstop",
      message: "request exceeded 200ms",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/refused it, so it ran nothing; click again/);
    expect(plan.stderr).not.toMatch(/unavailable|landed|running/);
  });

  test("the client's own clock cut the wait off: the outcome is unknown, and neither result is claimed", () => {
    const plan = urlHandlePlan({
      kind: "busy",
      phase: "deadline",
      message: "TIMEOUT",
    });
    expect(plan.code).toBe(0);
    expect(plan.stderr).toMatch(/may or may not have run/);
    expect(plan.stderr).not.toMatch(/ran nothing|click again|landed/);
  });
});

test("no daemon answering is exit 1", () => {
  expect(
    urlHandlePlan({
      kind: "transient",
      cause: "unreachable",
      message: "ENOENT",
    }),
  ).toMatchObject({ code: 1, stderr: expect.stringContaining("daemon unavailable") });
});

test("a daemon's refusal is exit 1", () => {
  expect(
    urlHandlePlan({
      kind: "permanent",
      cause: "bad_request",
      message: "no verb",
    }),
  ).toMatchObject({ code: 1 });
});
