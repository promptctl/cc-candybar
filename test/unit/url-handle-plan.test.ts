// [LAW:behavior-not-structure] What url-handle tells its reader when the daemon
// did not answer a click with its outcome. No busy answer confirms the click
// ran, so each exits 1, and the text says what became of the click: refused or
// never sent (click again), or cut off by the client's own clock (unknown,
// claiming neither result, since a second click on one that ran can revert it).

import { urlHandlePlan } from "../../src/install/index";

describe("urlHandlePlan on a busy daemon", () => {
  test("a connect timeout never delivered the click, so click again", () => {
    const plan = urlHandlePlan({
      kind: "busy",
      phase: "connect",
      message: "CONNECT_TIMEOUT",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/never sent; click again/);
  });

  test("the daemon's own TIMEOUT refused the click unread, so click again", () => {
    const plan = urlHandlePlan({
      kind: "busy",
      phase: "backstop",
      message: "request exceeded 200ms",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/refused it; click again/);
    expect(plan.stderr).not.toMatch(/unavailable|landed|running/);
  });

  test("the client's own clock cut the wait off: the outcome is unknown, and neither result is claimed", () => {
    const plan = urlHandlePlan({
      kind: "busy",
      phase: "deadline",
      message: "TIMEOUT",
    });
    expect(plan.code).toBe(1);
    expect(plan.stderr).toMatch(/may or may not have run/);
    expect(plan.stderr).not.toMatch(/refused|never sent|\bclick again|landed/);
  });
});

test("no daemon answering is exit 1", () => {
  expect(
    urlHandlePlan({
      kind: "transient",
      cause: "unreachable",
      message: "ENOENT",
    }),
  ).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("daemon unavailable"),
  });
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
