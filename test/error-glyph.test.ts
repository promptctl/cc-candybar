import type { Duplex } from "node:stream";
import { heldClock } from "./helpers/held-clock";
import { memoryConnection } from "../src/dial/dialer-fake";
import { RENDER_BUDGETS } from "../src/daemon/client";
import { exchangeOutcome } from "../src/daemon/client-transport";
import { formatPermanentGlyph } from "../src/render/error-glyph";
import type { PermanentOutcome } from "../src/daemon/client-transport";
import { versionGate } from "../src/daemon/reply";
import {
  PROTOCOL_VERSION,
  type Request,
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/protocol";

// [LAW:behavior-not-structure] These tests assert the contract — the glyph's
// visible text, single-line shape, prefix, and reset tail — not the
// implementation. Each cause's exact glyph is in the one table both runtimes
// assert (test/diagnostic-text-cases.test.ts).

const OPEN = "\x1b[48;2;200;40;40m\x1b[38;2;255;255;255m";
const TAIL = "\x1b[0m\n";
const PREFIX = "⚠ cc-candybar: ";

// [LAW:one-source-of-truth] Fixtures derive both versions from the canonical
// PROTOCOL_VERSION imported at the top of this file. Expected strings are
// built via template literals against the same source. A PROTOCOL_VERSION
// bump in src/daemon/protocol.ts flows through here automatically.
const CLIENT_V = PROTOCOL_VERSION;
const OTHER_V = PROTOCOL_VERSION + 1;

describe("formatPermanentGlyph (kz8.5 ch.2)", () => {
  const allCauses: PermanentOutcome[] = [
    {
      kind: "permanent",
      cause: "version_mismatch",
      clientV: CLIENT_V,
      daemonV: OTHER_V,
    },
    { kind: "permanent", cause: "bad_request", message: "nope" },
    { kind: "permanent", cause: "render_failed", message: "boom" },
    { kind: "permanent", cause: "malformed_response", message: "garbage" },
  ];

  test("every cause produces a single-line ANSI-decorated string", () => {
    for (const outcome of allCauses) {
      const glyph = formatPermanentGlyph(outcome);
      expect(glyph.startsWith(`${OPEN}${PREFIX}`)).toBe(true);
      expect(glyph.endsWith(TAIL)).toBe(true);
      // Exactly one \n — the trailing one. No embedded newlines mid-string.
      expect(glyph.split("\n").length).toBe(2);
      expect(glyph.endsWith("\n")).toBe(true);
    }
  });

  // [LAW:one-type-per-behavior] The single-line glyph contract documented in
  // src/render/error-glyph.ts and rust-client/src/error_glyph.rs requires no
  // embedded newlines mid-string. The current corpus uses inputs without
  // newlines, so the contract was previously asserted but unverified for the
  // adversarial case where a daemon error string contains \n or \r. Both
  // newline classes are sanitized to spaces at the same boundary that
  // enforces the code-point budget.
  // [LAW:one-type-per-behavior] ESC and other C0 controls would otherwise
  // let a daemon (or a caller whose input the daemon echoes) inject ANSI
  // sequences that hijack the glyph's styled envelope. The fix sanitizes
  // the entire C0 range + DEL to spaces at the same boundary that handles
  // LF/CR. This test pins the specific attack shape — an `\x1b[0m` mid-
  // message MUST NOT survive the truncate pass.
  test("control characters (C0, DEL, and C1/8-bit CSI) are sanitized to spaces", () => {
    // 0x1B = ESC (7-bit CSI introducer), 0x9B = 8-bit CSI (some terminals
    // interpret this directly without needing ESC). The sanitizer must
    // neutralize BOTH so a daemon-echoed payload can't reach the terminal
    // via either path. 0x07 (BEL) and 0x7F (DEL) included as extra coverage
    // across the C0 range plus DEL.
    const escapeInjection =
      "verb=danger\x1b[0m injected\x1b[31m text\x9b[0mbypass\x07\x7f end";
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "bad_request",
      message: escapeInjection,
    });
    const body = glyph.slice(OPEN.length, -TAIL.length);
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);
      // Unicode Cc class = C0 (0x00..=0x1F) + DEL (0x7F) + C1 (0x80..=0x9F).
      // Every code point in this class must have been replaced.
      const isControl =
        code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      expect(isControl).toBe(false);
    }
    // The styled glyph envelope (OPEN…TAIL) is intact.
    expect(glyph.startsWith(OPEN)).toBe(true);
    expect(glyph.endsWith(TAIL)).toBe(true);
    // Safe text retained.
    expect(body).toContain("verb=danger");
    expect(body).toContain("injected");
    expect(body).toContain("bypass");
  });

  test("embedded newlines in daemon error string are sanitized + collapsed to single spaces", () => {
    // [LAW:behavior-not-structure] The load-bearing contract is "no embedded
    // newline/CR/control-char in the output". The shared sanitizer now also
    // collapses runs of whitespace to a single space (so the daemon-side
    // diagnostic strip — which surfaces multi-line config errors with
    // existing indentation — displays as a clean single line). The
    // permanent-glyph path inherits that behavior; we assert what every
    // caller cares about (no embedded line breaks, content preserved in
    // order) rather than the exact count of separator spaces.
    const cases: Array<[string, string[]]> = [
      ["line1\nline2\nline3", ["line1", "line2", "line3"]],
      ["line1\rline2\rline3", ["line1", "line2", "line3"]],
      ["line1\r\nline2\r\nline3", ["line1", "line2", "line3"]],
    ];
    for (const [message, parts] of cases) {
      const glyph = formatPermanentGlyph({
        kind: "permanent",
        cause: "render_failed",
        message,
      });
      // Exactly one \n total — the trailing one from the ANSI reset tail.
      expect(glyph.split("\n").length).toBe(2);
      expect(glyph.endsWith(TAIL)).toBe(true);
      const body = glyph.slice(OPEN.length, -TAIL.length);
      expect(body).not.toMatch(/[\n\r]/);
      // Each part appears, in order, separated by exactly one space.
      expect(body).toContain(parts.join(" "));
    }
  });
});

// --- end-to-end: daemon's answer → exchangeOutcome → formatPermanentGlyph ---
//
// [LAW:behavior-not-structure] The pipeline contract: a daemon that returns
// VERSION_MISMATCH causes the client to produce a permanent/version_mismatch
// outcome, and the glyph formatter on that outcome carries the version
// numbers in its visible text. This is the load-bearing path — the whole
// point of chunk 2 is that this end-to-end flow produces a readable error
// instead of a blank statusline.
//
// [LAW:locality-or-seam] The daemon is the other end of an in-memory
// connection and the client's clock is held, so the request, the frame reader
// and the classification run as shipped with no listener or budget for a
// loaded loop to miss.

// [LAW:one-source-of-truth] The daemon end runs the real version gate one
// version ahead of the client, so the reply the client classifies is the one
// a newer daemon's gate sends a stale client. Only the gate runs: a request
// the daemon would reject as malformed is not this test's concern. A fault in the daemon end is kept, not
// thrown: a throw unwinds into the client's own catch and comes back as an
// outcome without its message, so the test asserts there were none.
function mismatchingDaemonEnd(daemonEnd: Duplex): Error[] {
  const faults: Error[] = [];
  daemonEnd.on(
    "data",
    makeFrameReader(
      (frame) => {
        const handled = versionGate(frame as Request, () => {}, OTHER_V);
        if (handled?.kind !== "reply") {
          faults.push(new Error("the version gate admitted a stale client"));
          daemonEnd.destroy();
          return;
        }
        daemonEnd.write(encodeFrame(handled.resp));
        daemonEnd.end();
      },
      (err) => {
        faults.push(err);
        daemonEnd.destroy();
      },
    ),
  );
  return faults;
}

describe("VERSION_MISMATCH wire → permanent outcome → glyph", () => {
  test("the daemon's VERSION_MISMATCH reply yields a glyph that names both versions", async () => {
    const { daemonEnd, client } = memoryConnection();
    const faults = mismatchingDaemonEnd(daemonEnd);

    const outcome = await exchangeOutcome(
      client,
      heldClock(new Date()),
      (deadline) => ({
        kind: "render",
        hookData: {
          session_id: "test-glyph-session",
          workspace: { project_dir: "/tmp" },
          model: { id: "x", display_name: "X" },
        } as never,
        args: ["cc-candybar"],
        cwd: "/tmp",
        deadline,
      }),
      RENDER_BUDGETS,
      // The daemon never answers ok here, so nothing is projected.
      (): string | undefined => undefined,
    );
    expect(faults).toEqual([]);
    expect(outcome.kind).toBe("permanent");
    if (outcome.kind !== "permanent") return;
    expect(outcome.cause).toBe("version_mismatch");
    if (outcome.cause !== "version_mismatch") return;
    expect(outcome.clientV).toBe(PROTOCOL_VERSION);
    expect(outcome.daemonV).toBe(OTHER_V);

    const glyph = formatPermanentGlyph(outcome);
    expect(glyph).toContain(`client v${PROTOCOL_VERSION}`);
    expect(glyph).toContain(`daemon v${OTHER_V}`);
    expect(glyph.startsWith(OPEN)).toBe(true);
    expect(glyph.endsWith(TAIL)).toBe(true);
  });
});
