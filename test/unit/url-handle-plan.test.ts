// [LAW:behavior-not-structure] What a click does when the daemon did not
// answer it: the exit code is the handler app's error dialog, so it must say
// whether the click is lost. A click the daemon never accepted is lost (exit 1,
// a listener holds the socket); one it accepted and then ran out of
// time on may still land or be refused as stale, and its log says which (exit 0).

import { urlHandlePlan } from "../../src/install/index";

describe("urlHandlePlan on a busy daemon", () => {
  test("a connect timeout never delivered the click: exit 1", () => {
    expect(
      urlHandlePlan({
        kind: "busy",
        phase: "connect",
        message: "CONNECT_TIMEOUT",
      }),
    ).toMatchObject({ code: 1 });
  });

  test("a deadline, ours or the daemon's own TIMEOUT, delivered it: exit 0", () => {
    expect(
      urlHandlePlan({ kind: "busy", phase: "deadline", message: "TIMEOUT" }),
    ).toMatchObject({ code: 0 });
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
