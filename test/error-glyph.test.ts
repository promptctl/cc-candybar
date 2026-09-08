import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { formatPermanentGlyph } from "../src/render/error-glyph";
import type { PermanentOutcome } from "../src/daemon/client-transport";
import { PROTOCOL_VERSION, encodeFrame, makeFrameReader } from "../src/daemon/protocol";

// [LAW:behavior-not-structure] The contract is the glyph's visible text, not the implementation; the Rust mirror pins byte-identical output.

const OPEN = "\x1b[48;2;200;40;40m\x1b[38;2;255;255;255m";
const TAIL = "\x1b[0m\n";
const PREFIX = "⚠ cc-candybar: ";

// [LAW:one-source-of-truth] Fixtures derive both versions from PROTOCOL_VERSION, so a bump flows through automatically.
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
    expect(glyph).not.toContain("x".repeat(200));
    expect(glyph).toContain("…");
    const body = glyph.slice(OPEN.length, -TAIL.length);
    expect(body.length).toBeLessThan(100);
  });

  // [LAW:one-type-per-behavior] Newlines and the whole C0 range + DEL are sanitized to
  // spaces at the boundary that enforces the code-point budget, so no injected ANSI survives.
  test("control characters (C0, DEL, and C1/8-bit CSI) are sanitized to spaces", () => {
    // 0x1B is the 7-bit CSI introducer and 0x9B the 8-bit one; both must be neutralized.
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
      const isControl =
        code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
      expect(isControl).toBe(false);
    }
    expect(glyph.startsWith(OPEN)).toBe(true);
    expect(glyph.endsWith(TAIL)).toBe(true);
    expect(body).toContain("verb=danger");
    expect(body).toContain("injected");
    expect(body).toContain("bypass");
  });

  test("embedded newlines in daemon error string are sanitized + collapsed to single spaces", () => {
    // [LAW:behavior-not-structure] Assert no embedded line breaks and content in order, not the exact separator-space count.
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
      expect(glyph.split("\n").length).toBe(2);
      expect(glyph.endsWith(TAIL)).toBe(true);
      const body = glyph.slice(OPEN.length, -TAIL.length);
      expect(body).not.toMatch(/[\n\r]/);
      expect(body).toContain(parts.join(" "));
    }
  });

  // [LAW:one-type-per-behavior] Truncation counts Unicode scalar values, not UTF-16 units, or the Rust mirror diverges.
  test("truncation counts code points, not UTF-16 units (astral-safe)", () => {
    const rockets = "🚀".repeat(100);
    const glyph = formatPermanentGlyph({
      kind: "permanent",
      cause: "render_failed",
      message: rockets,
    });
    const body = glyph.slice(OPEN.length + PREFIX.length, -TAIL.length);
    const message = body.slice("render failed: ".length);
    expect([...message].length).toBe(60);
    expect(message.endsWith("…")).toBe(true);
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

// [LAW:behavior-not-structure] End to end: a VERSION_MISMATCH daemon reply must reach the glyph as readable text, not a blank statusline.

function spinUpMismatchSocket(
  sockPath: string,
  daemonV: number,
): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const reader = makeFrameReader(
        (frame) => {
          const req = frame as { v?: number };
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
    const daemonV = PROTOCOL_VERSION + 7;

    const server = await spinUpMismatchSocket(sockPath, daemonV);
    const prevXdg = process.env.XDG_STATE_HOME;
    const prevSock = process.env.CC_CANDYBAR_SOCKET;
    process.env.XDG_STATE_HOME = tmpRoot;
    process.env.CC_CANDYBAR_SOCKET = sockPath;
    try {
      // Import client lazily so socketPath() resolves to CC_CANDYBAR_SOCKET.
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
      }
    }
  });
});
