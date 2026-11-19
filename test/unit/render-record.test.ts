// [LAW:verifiable-goals] What a render's event and the stats record is the
// answer its client is sent: a render too big to send is RENDER_FAILED to the
// client and a failure in the daemon's own record, never an ok render.

import { MAX_FRAME_BYTES } from "../../src/daemon/foundations/protocol";
import { requestEvent } from "../../src/daemon/foundations/request-event";
import { NOTHING_TO_SETTLE } from "../../src/daemon/statusline-answer";
import { renderRecord } from "../../src/daemon/reply";

const rendered = (output: string) => ({
  outcome: { kind: "ok" } as const,
  resp: { ok: true, output } as const,
  settled: NOTHING_TO_SETTLE,
});

test("a render that fits is recorded as it rendered, and sent whole", () => {
  const { reply, outcome } = renderRecord(rendered("the bar"));
  expect({ outcome, resp: reply.resp, unsent: reply.unsent }).toEqual({
    outcome: { kind: "ok" },
    resp: { ok: true, output: "the bar" },
    unsent: null,
  });
});

test("a render too big to send is recorded as the failure its client is sent", () => {
  const { reply, outcome } = renderRecord(
    rendered("x".repeat(MAX_FRAME_BYTES + 1)),
  );
  expect(reply.resp).toMatchObject({
    ok: false,
    code: "RENDER_FAILED",
    error: expect.stringContaining("byte cap"),
  });
  expect(outcome).toMatchObject({
    kind: "threw",
    message: expect.stringContaining("byte cap"),
  });
  expect(requestEvent("render", [], outcome, 1).level).toBe("error");
});
