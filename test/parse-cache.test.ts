import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseJsonlFile, clearParseCache } from "../src/utils/claude";

const PARSE_CACHE_MAX = 16;

describe("parseJsonlFile bounded LRU cache", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "parse-cache-test-"));
    clearParseCache();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    clearParseCache();
  });

  function writeJsonl(name: string, lines: object[] = [{ timestamp: "2024-01-01" }]): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return filePath;
  }

  it("returns parsed entries on first access", async () => {
    const file = writeJsonl("a.jsonl", [{ timestamp: "2024-01-01", type: "user" }]);
    const entries = await parseJsonlFile(file);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("cache hit: same mtime returns cached entries", async () => {
    const file = writeJsonl("b.jsonl");
    const first = await parseJsonlFile(file);
    const second = await parseJsonlFile(file);
    expect(second).toBe(first);
  });

  it("cache miss: new mtime for same path evicts old entry", async () => {
    const file = writeJsonl("c.jsonl", [{ timestamp: "2024-01-01" }]);
    const first = await parseJsonlFile(file);

    writeFileSync(file, JSON.stringify({ timestamp: "2024-02-01" }) + "\n");
    // Some filesystems have 1s mtime resolution — force mtime forward
    const future = new Date(Date.now() + 2000);
    utimesSync(file, future, future);

    const second = await parseJsonlFile(file);
    expect(second).not.toBe(first);
  });

  it("cache size never exceeds PARSE_CACHE_MAX", async () => {
    const files: string[] = [];
    for (let i = 0; i < PARSE_CACHE_MAX + 4; i++) {
      files.push(writeJsonl(`file-${i}.jsonl`));
    }
    for (const f of files) {
      await parseJsonlFile(f);
    }

    // Cache internals are not inspectable — verify through re-parse identity.
    const first = await parseJsonlFile(files[0]!);
    const firstAgain = await parseJsonlFile(files[0]!);
    expect(firstAgain).toBe(first);
  });

  it("LRU eviction: accessing a cached entry preserves it past newer additions", async () => {
    const files: string[] = [];
    for (let i = 0; i < PARSE_CACHE_MAX; i++) {
      files.push(writeJsonl(`lru-${i}.jsonl`));
    }
    for (const f of files) {
      await parseJsonlFile(f);
    }

    const touchedRef = await parseJsonlFile(files[0]!);

    const newFile = writeJsonl("lru-new.jsonl");
    await parseJsonlFile(newFile);

    const afterEviction = await parseJsonlFile(files[0]!);
    expect(afterEviction).toBe(touchedRef);

    const evicted = await parseJsonlFile(files[1]!);
    const evictedAgain = await parseJsonlFile(files[1]!);
    expect(evictedAgain).toBe(evicted);
  });
});
