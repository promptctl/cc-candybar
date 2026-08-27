import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatPermanentGlyph } from "../src/render/error-glyph";
import type { PermanentOutcome } from "../src/daemon/client-transport";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";

// [LAW:behavior-not-structure] These tests assert the contract — the glyph's
// visible text, single-line shape, prefix, and reset tail — not the
// implementation. The Rust mirror (rust-client/src/error_glyph.rs) carries an
// equivalent unit test that pins byte-identical output for the same causes.

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

  test("version_mismatch carries client and daemon versions in visible text", () => {
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: CLIENT_V,
      daemonV: OTHER_V,
    });
    expect(glyph).toContain(
      `protocol mismatch (client v${CLIENT_V} ≠ daemon v${OTHER_V})`,
    );
  });

  test("version_mismatch with daemonV=0 renders as 'unknown' (older daemons)", () => {
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "version_mismatch",
      clientV: CLIENT_V,
      daemonV: 0,
    });
    expect(glyph).toContain(`client v${CLIENT_V} ≠ daemon unknown`);
    expect(glyph).not.toContain("daemon v0");
  });

  test("bad_request message is included verbatim when short", () => {
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "bad_request",
      message: "unknown kind",
    });
    expect(glyph).toContain("daemon rejected request: unknown kind");
  });

  test("render_failed message is included verbatim when short", () => {
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "render_failed",
      message: "segments threw",
    });
    expect(glyph).toContain("render failed: segments threw");
  });

  test("malformed_response message is included verbatim when short", () => {
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "malformed_response",
      message: "stats response to render/click",
    });
    expect(glyph).toContain(
      "malformed daemon response: stats response to render/click",
    );
  });

  test("long messages are truncated to a single-line budget", () => {
    const long = "x".repeat(200);
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "render_failed",
      message: long,
    });
    // 60-char budget: 59 x's then an ellipsis. The full 200 must not appear.
    expect(glyph).not.toContain("x".repeat(200));
    expect(glyph).toContain("…");
    // Body fits well under any reasonable statusline width.
    const body = glyph.slice(OPEN.length, -TAIL.length);
    expect(body.length).toBeLessThan(100);
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

  // [LAW:one-type-per-behavior] Truncation must count Unicode scalar values,
  // not UTF-16 code units. Astral characters (each 2 UTF-16 units / 1 code
  // point) would otherwise truncate at a different boundary than the Rust
  // mirror, and the byte-identical contract this module advertises would only
  // hold for ASCII input. Rocket (U+1F680) is a single emoji that exercises
  // surrogate-pair handling specifically.
  test("truncation counts code points, not UTF-16 units (astral-safe)", () => {
    const rockets = "🚀".repeat(100); // 100 code points, 200 UTF-16 units
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "render_failed",
      message: rockets,
    });
    const body = glyph.slice(OPEN.length + PREFIX.length, -TAIL.length);
    // After "render failed: " prefix in the body, the message is truncated
    // to exactly MAX_MESSAGE_LEN code points (59 rockets + ellipsis).
    const message = body.slice("render failed: ".length);
    expect([...message].length).toBe(60);
    expect(message.endsWith("…")).toBe(true);
    // Critically, no lone surrogate ever appears in the output.
    for (let i = 0; i < glyph.length; i++) {
      const code = glyph.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const isLow = code >= 0xdc00 && code <= 0xdfff;
      if (isHigh) {
        const next = glyph.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
      if (isLow) {
        const prev = glyph.charCodeAt(i - 1);
        expect(prev >= 0xd800 && prev <= 0xdbff).toBe(true);
      }
    }
  });
});

// --- end-to-end: stubbed daemon → tryRenderViaDaemon → formatPermanentGlyph ---
//
// [LAW:behavior-not-structure] The pipeline contract: a daemon that returns
// VERSION_MISMATCH causes the client to produce a permanent/version_mismatch
// outcome, and the glyph formatter on that outcome carries the version
// numbers in its visible text. This is the load-bearing path — the whole
// point of chunk 2 is that this end-to-end flow produces a readable error
// instead of a blank statusline.

function spinUpMismatchSocket(
  sockPath: string,
  daemonV: number,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        (frame) => {
          const req = frame as { v?: number };
          // The stubbed daemon always answers VERSION_MISMATCH (with daemonV
          // echoed) regardless of the actual request version — we want to
          // observe what happens when the daemon disagrees with the client.
          sock.write(
            encodeFrame({
              ok: false,
              error: `protocol v${req.v ?? "?"} not supported (daemon at v${daemonV})`,
              code: "VERSION_MISMATCH",
              daemonV,
            }),
          );
          sock.end();
        },
        () => {
          /* parse error ignored on daemon side */
        },
      );
      sock.on("data", reader);
    });
    server.listen(sockPath, () => resolve(server));
  });
}

describe("end-to-end: VERSION_MISMATCH wire → permanent outcome → glyph", () => {
  test("stubbed daemon at a different protocol version yields a glyph that names both versions", async () => {
    const tmpRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "cc-candybar-glyph-"),
    );
    const stateDir = path.join(tmpRoot, "cc-candybar");
    fs.mkdirSync(stateDir, { recursive: true });
    const sockPath = path.join(stateDir, "socket");
    const daemonV = PROTOCOL_VERSION + 7; // arbitrary "other" version

    const server = await spinUpMismatchSocket(sockPath, daemonV);
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevSock = process.env.CC_CANDYBAR_SOCKET;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.CC_CANDYBAR_SOCKET = sockPath;
    try {
      // Import client lazily so socketPath() resolves to CC_CANDYBAR_SOCKET
      // (paths.ts reads env at call time, but using a fresh import is robust
      // against any future caching of the resolved path).
      const { tryRenderViaDaemon } = await import("../src/daemon/client");
      const outcome = await tryRenderViaDaemon(
        {
          session_id: "test-glyph-session",
          workspace: { project_dir: "/tmp" },
          model: { id: "x", display_name: "X" },
        } as never,
        ["cc-candybar"],
        "/tmp",
        {},
      );
      expect(outcome.kind).toBe("permanent");
      if (outcome.kind !== "permanent") return;
      expect(outcome.cause).toBe("version_mismatch");
      if (outcome.cause !== "version_mismatch") return;
      expect(outcome.clientV).toBe(PROTOCOL_VERSION);
      expect(outcome.daemonV).toBe(daemonV);

      const glyph = formatPermanentGlyph(outcome);
      expect(glyph).toContain(`client v${PROTOCOL_VERSION}`);
      expect(glyph).toContain(`daemon v${daemonV}`);
      expect(glyph.startsWith(OPEN)).toBe(true);
      expect(glyph.endsWith(TAIL)).toBe(true);
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = prevXdg;
      if (prevSock === undefined) delete process.env.CC_CANDYBAR_SOCKET;
      else process.env.CC_CANDYBAR_SOCKET = prevSock;
      await new Promise<void>((r) => server.close(() => r()));
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* tmpdir cleanup best-effort */
      }
    }
  });
});
