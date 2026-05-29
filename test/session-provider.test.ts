// [LAW:one-source-of-truth] parseJsonlFile hands out its cached entries array
// by reference; that cache is the canonical parsed form of a file, shared
// across providers. getSessionUsageFromPath combines a session's main + agent
// transcripts — it must do so WITHOUT mutating the cached arrays, or a warm
// cache hit double-counts agents and leaks them into the main transcript's
// cached value (the bug Copilot caught on PR #50).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionProvider } from "../src/segments/session";
import { parseJsonlFile, clearParseCache } from "../src/utils/claude";

function line(tag: string, cost: number, extra: object = {}): string {
  return (
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: `req-${tag}`,
      costUSD: cost,
      message: {
        id: `msg-${tag}`,
        model: "claude-opus-4-8",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      ...extra,
    }) + "\n"
  );
}

describe("SessionProvider.getSessionUsageFromPath", () => {
  let dir: string;
  let mainPath: string;
  const sid = "sess-1";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-candybar-sp-"));
    mainPath = join(dir, `${sid}.jsonl`);
    writeFileSync(mainPath, line("main", 0.01));
    // Agent transcript discovered via <projectDir>/<sid>/subagents/agent-*.jsonl;
    // findAgentTranscripts keeps it only when its first line's sessionId matches.
    const subagents = join(dir, sid, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-1.jsonl"),
      line("agent", 0.02, { sessionId: sid }),
    );
    clearParseCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("combines main + agents without double-counting on a warm parse cache", async () => {
    const sp = new SessionProvider();
    const first = await sp.getSessionUsageFromPath(sid, mainPath);
    expect(first?.totalCost).toBeCloseTo(0.03, 5);
    expect(first?.entries).toHaveLength(2);

    // Second call with the parse cache warm (same mtime) must yield the SAME
    // totals — the old push-into-cached-array mutated the main transcript's
    // cached entries, so this returned 0.05 / 3 entries.
    const second = await sp.getSessionUsageFromPath(sid, mainPath);
    expect(second?.totalCost).toBeCloseTo(0.03, 5);
    expect(second?.entries).toHaveLength(2);
  });

  test("does not corrupt the shared parse cache for the main transcript", async () => {
    const sp = new SessionProvider();
    await sp.getSessionUsageFromPath(sid, mainPath);
    // A direct read of the main transcript must still see ONLY its own entry —
    // agent entries must never have leaked into its cached array.
    const mainOnly = await parseJsonlFile(mainPath);
    expect(mainOnly).toHaveLength(1);
  });
});
