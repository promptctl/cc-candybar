// [LAW:verifiable-goals] The vars/segments/config CLI's own logic is the renderer
// (the socket round-trip is the shared client-transport primitive, exercised by
// the debug protocol's own tests). `formatDebug` is a pure total fold over the
// DebugSnapshot union; we assert its behavior per arm — populated and empty —
// with constructed snapshots, the same way daemon-debug.test.ts drives the
// introspector.

import { formatDebug } from "../src/daemon/client-debug";
import type { DebugSnapshot } from "../src/daemon/debug-types";

describe("formatDebug", () => {
  it("renders populated vars with name, source, and value", () => {
    const snap: DebugSnapshot = {
      what: "vars",
      vars: [
        {
          name: "git.branch",
          source: "git",
          type: "string",
          value: "main",
          lastError: null,
          ageMs: 1200,
        },
      ],
    };
    const out = formatDebug(snap);
    expect(out).toContain("variables (1)");
    expect(out).toContain("git.branch");
    expect(out).toContain("git");
    expect(out).toContain("main");
  });

  it("surfaces a variable's last error", () => {
    const snap: DebugSnapshot = {
      what: "vars",
      vars: [
        {
          name: "user_path",
          source: "env",
          type: "string",
          value: "(unset)",
          lastError: { timestampMs: 0, message: "env var not set" },
          ageMs: null,
        },
      ],
    };
    expect(formatDebug(snap)).toContain("env var not set");
  });

  it("renders empty vars as 'DSL not active'", () => {
    expect(formatDebug({ what: "vars", vars: [] })).toContain("DSL not active");
  });

  it("renders segments with template and referenced vars", () => {
    const snap: DebugSnapshot = {
      what: "segments",
      segments: [
        {
          name: "git",
          template: "{{ .git.branch }}",
          referencedVars: ["git.branch"],
          lastRender: null,
        },
      ],
    };
    const out = formatDebug(snap);
    expect(out).toContain("segments (1)");
    expect(out).toContain("{{ .git.branch }}");
    expect(out).toContain("git.branch");
  });

  it("renders a null config as 'DSL not active'", () => {
    expect(formatDebug({ what: "config", config: null })).toContain(
      "DSL not active",
    );
  });

  it("renders a present config as pretty JSON", () => {
    const config = {
      globals: { palette: "dracula" },
    } as unknown as Extract<DebugSnapshot, { what: "config" }>["config"];
    const out = formatDebug({ what: "config", config });
    expect(out).toContain('"palette": "dracula"');
  });
});
