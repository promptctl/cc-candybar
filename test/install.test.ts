import { parseHandlerUrl, locateBundledDist, __test__ } from "../src/install";
import {
  applyClickActions,
  buildClickUrl,
  wrapOsc8,
} from "../src/segments/renderer";

const { shellEscape, buildStatusLineCommand, DEFAULT_INSTALL_ARGS } = __test__;

describe("install — parseHandlerUrl", () => {
  it("treats cpwl://<value> as verb=copy", () => {
    expect(parseHandlerUrl("cpwl://abc-123")).toEqual({
      verb: "copy",
      value: "abc-123",
    });
  });

  it("parses explicit verb", () => {
    expect(parseHandlerUrl("cpwl://copy/abc-123")).toEqual({
      verb: "copy",
      value: "abc-123",
    });
  });

  it("preserves case in the value", () => {
    // new URL() lowercases hosts; manual parse must not.
    expect(parseHandlerUrl("cpwl://AbC-DeF").value).toBe("AbC-DeF");
  });

  it("decodes percent-escaped value", () => {
    expect(parseHandlerUrl("cpwl://hello%20world")).toEqual({
      verb: "copy",
      value: "hello world",
    });
    expect(parseHandlerUrl("cpwl://copy/hello%20world").value).toBe(
      "hello world",
    );
  });

  it("preserves slashes inside the value (verb form)", () => {
    expect(parseHandlerUrl("cpwl://copy/a/b/c").value).toBe("a/b/c");
  });

  it("rejects mismatched scheme", () => {
    expect(() => parseHandlerUrl("http://abc")).toThrow(/expected cpwl/);
  });

  it("respects custom scheme parameter", () => {
    expect(parseHandlerUrl("foo://bar", "foo")).toEqual({
      verb: "copy",
      value: "bar",
    });
  });
});

describe("install — locateBundledDist", () => {
  it("returns argv[1] directly when it ends in .mjs", () => {
    expect(locateBundledDist("/path/to/dist/index.mjs")).toBe(
      "/path/to/dist/index.mjs",
    );
  });

  it("returns argv[1] directly when it ends in .js", () => {
    expect(locateBundledDist("/path/to/dist/index.js")).toBe(
      "/path/to/dist/index.js",
    );
  });

  it("resolves to sibling dist/index.mjs for bin shim", () => {
    expect(locateBundledDist("/usr/local/bin/claude-powerline")).toBe(
      "/usr/local/dist/index.mjs",
    );
  });

  it("handles npm @scope/pkg layout", () => {
    expect(
      locateBundledDist(
        "/Users/x/.pnpm/store/v3/@promptctl+claude-powerline@0.2.0/bin/claude-powerline",
      ),
    ).toBe(
      "/Users/x/.pnpm/store/v3/@promptctl+claude-powerline@0.2.0/dist/index.mjs",
    );
  });

  it("throws on undefined argv[1]", () => {
    expect(() => locateBundledDist(undefined)).toThrow(/argv\[1\]/);
  });
});

describe("install — shellEscape", () => {
  it("leaves safe args unquoted", () => {
    expect(shellEscape("--style=powerline")).toBe("--style=powerline");
    expect(shellEscape("git=workingTree,upstream")).toBe(
      "git=workingTree,upstream",
    );
    expect(shellEscape("/usr/local/bin/foo")).toBe("/usr/local/bin/foo");
  });

  it("single-quotes args with spaces or pipes", () => {
    expect(shellEscape("a b")).toBe("'a b'");
    expect(shellEscape("a|b")).toBe("'a|b'");
    expect(shellEscape("dir model | git")).toBe("'dir model | git'");
  });

  it("escapes single quotes inside the value", () => {
    expect(shellEscape("it's fine")).toBe("'it'\\''s fine'");
  });
});

describe("install — buildStatusLineCommand", () => {
  it("prepends pnpm dlx with a pinned version and shell-escapes args", () => {
    const cmd = buildStatusLineCommand([
      "--style=powerline",
      "--layout",
      "directory git | model",
    ]);
    // Version is replaced by tsdown's `define` at build time; in tests it
    // falls back to "dev". We assert the shape and the version-pinning, not
    // a specific version string.
    expect(cmd).toMatch(
      /^pnpm dlx @promptctl\/claude-powerline@[^\s]+ --style=powerline --layout 'directory git \| model'$/,
    );
    // Critically: must NOT use @latest (would defeat pnpm dlx cache busting).
    expect(cmd).not.toContain("@latest");
  });

  it("produces a stable string from DEFAULT_INSTALL_ARGS", () => {
    const cmd = buildStatusLineCommand(DEFAULT_INSTALL_ARGS);
    expect(cmd).toMatch(/^pnpm dlx @promptctl\/claude-powerline@[^\s]+ /);
    expect(cmd).not.toContain("@latest");
    expect(cmd).toContain("--style=powerline");
    expect(cmd).toContain(
      "'directory git | model context block weekly sessionId'",
    );
    expect(cmd).toContain("--show git=workingTree,upstream,timeSinceCommit");
    // Three click actions: copy (default), open jsonl, open project dir.
    expect(cmd).toContain("sessionId.clickAction.kind=url");
    expect(cmd).toContain("sessionId.clickAction.actions.0.verb=copy");
    expect(cmd).toContain(
      "sessionId.clickAction.actions.1.verb=open-vscode",
    );
    expect(cmd).toContain(
      "sessionId.clickAction.actions.1.source=transcriptPath",
    );
    expect(cmd).toContain(
      "sessionId.clickAction.actions.2.source=projectDir",
    );
  });
});

describe("renderer — wrapOsc8 / buildClickUrl", () => {
  it("wraps visible text in an OSC 8 hyperlink", () => {
    expect(wrapOsc8("hi", "cpwl://copy/abc")).toBe(
      "\u001b]8;;cpwl://copy/abc\u001b\\hi\u001b]8;;\u001b\\",
    );
  });

  it("URL-encodes the value in buildClickUrl", () => {
    expect(buildClickUrl("cpwl", "copy", "a b/c?d")).toBe(
      "cpwl://copy/a%20b%2Fc%3Fd",
    );
  });

  it("includes the verb in the URL", () => {
    expect(buildClickUrl("cpwl", "open-vscode", "/tmp/foo")).toBe(
      "cpwl://open-vscode/%2Ftmp%2Ffoo",
    );
  });
});

describe("renderer — applyClickActions", () => {
  const ctx = {
    sessionId: "abc-123",
    transcriptPath: "/tmp/log.jsonl",
    projectDir: "/tmp/proj",
  };

  it("returns visible text unchanged when no action", () => {
    expect(applyClickActions("hi", undefined, ctx)).toBe("hi");
  });

  it("first action without glyph wraps the visible text", () => {
    const got = applyClickActions("hi", {
      kind: "url",
      scheme: "cpwl",
      actions: [{ verb: "copy", source: "sessionId" }],
    }, ctx);
    expect(got).toBe("\u001b]8;;cpwl://copy/abc-123\u001b\\hi\u001b]8;;\u001b\\");
  });

  it("appends one OSC 8-wrapped glyph per extra action", () => {
    const got = applyClickActions("hi", {
      kind: "url",
      scheme: "cpwl",
      actions: [
        { verb: "copy", source: "sessionId" },
        { verb: "open-vscode", source: "transcriptPath", glyph: "📄" },
        { verb: "open-vscode", source: "projectDir", glyph: "📂" },
      ],
    }, ctx);
    expect(got).toContain("cpwl://copy/abc-123");
    expect(got).toContain(
      "cpwl://open-vscode/" + encodeURIComponent("/tmp/log.jsonl"),
    );
    expect(got).toContain(
      "cpwl://open-vscode/" + encodeURIComponent("/tmp/proj"),
    );
    expect(got).toContain("📄");
    expect(got).toContain("📂");
    expect(got.startsWith("\u001b]8;;cpwl://copy/abc-123")).toBe(true);
  });

  it("silently drops actions whose source is missing", () => {
    const got = applyClickActions("hi", {
      kind: "url",
      scheme: "cpwl",
      actions: [
        { verb: "copy", source: "sessionId" },
        { verb: "open-vscode", source: "projectDir", glyph: "📂" },
      ],
    }, { sessionId: "abc-123" });
    expect(got).toContain("cpwl://copy/abc-123");
    expect(got).not.toContain("📂");
  });

  it("only one action without a glyph wraps main text", () => {
    const got = applyClickActions("hi", {
      kind: "url",
      scheme: "cpwl",
      actions: [
        { verb: "copy", source: "sessionId" },
        // Second no-glyph entry is a misconfiguration; should be ignored,
        // not double-wrap.
        { verb: "open-vscode", source: "projectDir" },
      ],
    }, ctx);
    expect(got).toContain("cpwl://copy/abc-123");
    expect(got).not.toContain("cpwl://open-vscode");
  });
});
