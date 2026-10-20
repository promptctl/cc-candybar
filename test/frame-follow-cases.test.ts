// [LAW:one-source-of-truth] The frame follower's four decisions, from the one
// table both runtimes assert (test/fixtures/frame-follow-cases.json): the
// native client's `follow` (rust-client/src/follow.rs) reads the same file, so
// a decision changed in one runtime fails the other's test.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION, type Response } from "../src/daemon/protocol";
import { isRefusal, type StreamEnd } from "../src/daemon/client-frames";
import {
  afterStreamEnd,
  nextRetryMs,
  type RetryEvent,
} from "../src/daemon/frame-follow";
import { worthSaying, type Said } from "../src/frames-cli";

type Version = "older" | "newer";
interface Cases {
  readonly message: readonly {
    readonly resp: Record<string, unknown> & { daemonV?: Version };
    readonly refusal: boolean;
  }[];
  readonly streamEnd: readonly {
    readonly end:
      | { readonly kind: "failed" | "closed-there" }
      | { readonly kind: "refused"; readonly code: string; readonly daemonV?: Version };
    readonly then: { readonly kind: string; readonly kick?: boolean };
  }[];
  readonly worthSaying: readonly {
    readonly last: Said;
    readonly next: Exclude<Said, { kind: "none" }>;
    readonly says: boolean;
  }[];
  readonly backoff: readonly {
    readonly retryMs: number;
    readonly event: RetryEvent;
    readonly next: number;
  }[];
}

const CASES = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "frame-follow-cases.json"), "utf8"),
) as Cases;

const versionOf = (v: Version | undefined): number | undefined =>
  v === undefined ? undefined : v === "older" ? PROTOCOL_VERSION - 1 : PROTOCOL_VERSION + 1;

function responseOf(raw: Cases["message"][number]["resp"]): Response {
  const { daemonV, ...rest } = raw;
  const v = versionOf(daemonV);
  return (v === undefined ? rest : { ...rest, daemonV: v }) as unknown as Response;
}

function endOf(raw: Cases["streamEnd"][number]["end"]): Exclude<StreamEnd, { kind: "closed-here" }> {
  switch (raw.kind) {
    case "failed":
      return { kind: "failed", error: new Error("ECONNREFUSED") };
    case "closed-there":
      return { kind: "closed-there" };
    case "refused":
      return {
        kind: "refused",
        resp: responseOf({ ok: false, code: raw.code, error: "said", daemonV: raw.daemonV }) as Extract<Response, { ok: false }>,
      };
  }
}

test.each(CASES.message)("message %j: a refusal ends the stream, a frame is drawn", ({ resp, refusal }) => {
  expect(isRefusal(responseOf(resp))).toBe(refusal);
});

test.each(CASES.streamEnd)("stream end %j", ({ end, then }) => {
  const next = afterStreamEnd(endOf(end));
  expect({ kind: next.kind, ...(next.kind === "reconnect" && { kick: next.kick }) }).toEqual(then);
});

test.each(CASES.worthSaying)("worth saying %j", ({ last, next, says }) => {
  expect(worthSaying(last, next)).toBe(says);
});

test.each(CASES.backoff)("backoff %j", ({ retryMs, event, next }) => {
  expect(nextRetryMs(retryMs, event)).toBe(next);
});
