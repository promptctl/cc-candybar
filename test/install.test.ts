import { parseHandlerUrl, locateBundledDist, __test__ } from "../src/install";
import { wrapClickAction } from "../src/segments/renderer";

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
  it("prepends pnpm dlx with the latest tag and shell-escapes args", () => {
    const cmd = buildStatusLineCommand([
      "--style=powerline",
      "--layout",
      "directory git | model",
    ]);
    expect(cmd).toBe(
      "pnpm dlx @promptctl/claude-powerline@latest --style=powerline --layout 'directory git | model'",
    );
  });

  it("produces a stable string from DEFAULT_INSTALL_ARGS", () => {
    const cmd = buildStatusLineCommand(DEFAULT_INSTALL_ARGS);
    expect(cmd).toContain("pnpm dlx @promptctl/claude-powerline@latest");
    expect(cmd).toContain("--style=powerline");
    expect(cmd).toContain(
      "'directory git | model context block weekly sessionId'",
    );
    expect(cmd).toContain("--show git=workingTree,upstream,timeSinceCommit");
    expect(cmd).toContain(
      "--segment block.type=weighted,sessionId.length=8,sessionId.clickAction.kind=url,sessionId.clickAction.scheme=cpwl",
    );
  });
});

describe("renderer — wrapClickAction (OSC 8)", () => {
  it("returns visible text unchanged when no action", () => {
    expect(wrapClickAction("hi", "abc", undefined)).toBe("hi");
  });

  it("wraps in OSC 8 hyperlink for kind=url", () => {
    const got = wrapClickAction("test-ses", "test-session-12345", {
      kind: "url",
      scheme: "cpwl",
    });
    expect(got).toBe(
      "\u001b]8;;cpwl://test-session-12345\u001b\\test-ses\u001b]8;;\u001b\\",
    );
  });

  it("URL-encodes special chars in the payload", () => {
    const got = wrapClickAction("v", "a b/c?d", {
      kind: "url",
      scheme: "cpwl",
    });
    expect(got).toContain("cpwl://a%20b%2Fc%3Fd");
  });

  it("uses the configured scheme verbatim", () => {
    const got = wrapClickAction("v", "abc", { kind: "url", scheme: "myapp" });
    expect(got).toContain("myapp://abc");
  });
});
