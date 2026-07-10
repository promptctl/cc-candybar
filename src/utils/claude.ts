import { existsSync, createReadStream } from "node:fs";
// [LAW:single-enforcer] readdir/readFile/stat come from the gated transcript-fs
// owner, not node:fs/promises — the in-flight-I/O bound lives at one seam.
import { readdir, readFile, readAppended, stat } from "./transcript-fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { debug } from "./logger";
import { ok, type Outcome } from "./outcome";

export interface ClaudeHookData {
  // cc-candybar internal — not part of Anthropic's schema
  hook_event_name: string;

  // Always present per Anthropic schema
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: {
    id: string;
    display_name: string;
  };
  workspace: {
    current_dir: string;
    project_dir: string;
    // "Empty array if none have been added" — always present, not absent
    added_dirs: string[];
    // Absent when not inside a linked git worktree
    git_worktree?: string;
  };

  // Optional per Anthropic schema (listed under "Fields that may be absent")
  session_name?: string;
  version?: string;
  output_style?: {
    name: string;
  };
  cost?: {
    total_cost_usd: number;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
  };
  context_window?: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    // Always present within context_window, but value may be null (schema: "Fields that may be null")
    used_percentage: number | null;
    remaining_percentage: number | null;
    // Null before first API call and after /compact — present, not absent
    current_usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
    } | null;
  };
  exceeds_200k_tokens?: boolean;
  effort?: {
    level: string;
  };
  thinking?: {
    enabled: boolean;
  };
  rate_limits?: {
    five_hour?: {
      used_percentage: number;
      resets_at: number;
    };
    seven_day?: {
      used_percentage: number;
      resets_at: number;
    };
  };
  vim?: {
    mode: string;
  };
  agent?: {
    name: string;
  };
  worktree?: {
    name: string;
    path: string;
    branch?: string;
    original_cwd: string;
    original_branch?: string;
  };
}

export function getClaudePaths(): string[] {
  const paths: string[] = [];

  const envPath = process.env.CLAUDE_CONFIG_DIR;
  if (envPath) {
    envPath.split(",").forEach((path) => {
      const trimmedPath = path.trim();
      if (existsSync(trimmedPath)) {
        paths.push(trimmedPath);
      }
    });
  }

  if (paths.length === 0) {
    const homeDir = homedir();
    const configPath = join(homeDir, ".config", "claude");
    const claudePath = join(homeDir, ".claude");

    if (existsSync(configPath)) {
      paths.push(configPath);
    }
    if (existsSync(claudePath)) {
      paths.push(claudePath);
    }
  }

  return paths;
}

export async function findProjectPaths(
  claudePaths: string[],
): Promise<string[]> {
  const projectPaths: string[] = [];

  for (const claudePath of claudePaths) {
    const projectsDir = join(claudePath, "projects");

    if (existsSync(projectsDir)) {
      try {
        const entries = await readdir(projectsDir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const projectPath = join(projectsDir, entry.name);
            projectPaths.push(projectPath);
          }
        }
      } catch (error) {
        debug(`Failed to read projects directory ${projectsDir}:`, error);
      }
    }
  }

  return projectPaths;
}

export async function findAgentTranscripts(
  sessionId: string,
  projectPath: string,
): Promise<string[]> {
  const agentFiles: string[] = [];

  const subagentsDir = join(projectPath, sessionId, "subagents");

  try {
    const files = await readdir(subagentsDir);
    const agentFileNames = files.filter(
      (f) => f.startsWith("agent-") && f.endsWith(".jsonl"),
    );

    for (const fileName of agentFileNames) {
      const filePath = join(subagentsDir, fileName);
      try {
        const content = await readFile(filePath, "utf-8");
        const firstLine = content.split("\n")[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.sessionId === sessionId) {
            agentFiles.push(filePath);
          }
        }
      } catch {
        debug(`Failed to check agent file ${filePath}`);
      }
    }
  } catch (error) {
    debug(`Failed to read subagents directory ${subagentsDir}:`, error);
  }

  return agentFiles;
}

export async function getEarliestTimestamp(
  filePath: string,
): Promise<Date | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    let earliestDate: Date | null = null;
    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        if (json.timestamp && typeof json.timestamp === "string") {
          const date = new Date(json.timestamp);
          if (!isNaN(date.getTime())) {
            if (earliestDate === null || date < earliestDate) {
              earliestDate = date;
            }
          }
        }
      } catch {
        continue;
      }
    }
    return earliestDate;
  } catch (error) {
    debug(`Failed to get earliest timestamp for ${filePath}:`, error);
    return null;
  }
}

export async function sortFilesByTimestamp(
  files: string[],
  oldestFirst = true,
): Promise<string[]> {
  const filesWithTimestamps = await Promise.all(
    files.map(async (file) => ({
      file,
      timestamp: await getEarliestTimestamp(file),
    })),
  );

  return filesWithTimestamps
    .sort((a, b) => {
      if (a.timestamp === null && b.timestamp === null) return 0;
      if (a.timestamp === null) return 1;
      if (b.timestamp === null) return -1;
      const sortOrder = oldestFirst ? 1 : -1;
      return sortOrder * (a.timestamp.getTime() - b.timestamp.getTime());
    })
    .map((item) => item.file);
}

export async function getFileModificationDate(
  filePath: string,
): Promise<Date | null> {
  try {
    const stats = await stat(filePath);
    return stats.mtime;
  } catch {
    return null;
  }
}

// [LAW:types-are-the-program] exception: kept as type-aliases (not
// interfaces) so they're structurally assignable to `Record<string,
// unknown>` at the `extractModelId` boundary in segments/pricing.ts.
// Switching to `interface` removes the implicit index signature and
// breaks typecheck. A proper fix tightens that boundary to take
// `PrunedRaw` directly and is out of scope for the CI-fix branch.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
type UsageCounts = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

// [LAW:one-source-of-truth] The only fields ever read from raw are
// model, message.{id,model,usage}, and requestId. Storing the full
// parsed JSON (including content arrays with full message text) causes
// hundreds of MB of V8 heap churn per transcript re-parse. raw is
// pruned to this shape at parse time so the GC pressure is bounded.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type PrunedRaw = {
  model?: string;
  message?: { id?: string; model?: string; usage?: UsageCounts };
  requestId?: string;
};

export interface ParsedEntry {
  timestamp: Date;
  // [LAW:one-source-of-truth] The pruned projection carries every scalar any
  // consumer reads. `type`, `message.role/type/firstContentType` are the
  // message-classification discriminators the metrics segment needs; they are
  // small enum-like strings, so projecting them keeps metrics on this one parse
  // path WITHOUT retaining the multi-MB `message.content[]` arrays the pruning
  // exists to drop. `firstContentType` is the `type` of the first content block
  // only (undefined when content is text/absent) — never the array itself.
  type?: string;
  message?: {
    id?: string;
    usage?: UsageCounts;
    model?: string;
    role?: string;
    type?: string;
    firstContentType?: string;
  };
  costUSD?: number;
  isSidechain?: boolean;
  raw: PrunedRaw;
}

export function createUniqueHash(entry: ParsedEntry): string | null {
  // Both message.id paths are now equivalent (makeEntry syncs them), but
  // raw.message.id is kept as the canonical source to preserve call-site
  // compatibility with callers that pass a PrunedRaw directly.
  const messageId = entry.message?.id ?? entry.raw.message?.id;
  const requestId = entry.raw.requestId;

  if (!messageId || !requestId) {
    return null;
  }

  return `${messageId}:${requestId}`;
}

const STREAMING_THRESHOLD_BYTES = 1024 * 1024;

// [LAW:no-shared-mutable-globals] Bounded LRU — single owner, hard cap, documented invariants.
// Key: filePath. Value: last-seen mtime+size for freshness check plus parsed entries.
// Files larger than PARSE_CACHE_SKIP_BYTES are streamed and not retained (too expensive).
const PARSE_CACHE_MAX = 16;
const PARSE_CACHE_SKIP_BYTES = 5 * 1024 * 1024;

interface ParseCacheEntry {
  mtime: number;
  size: number;
  entries: ParsedEntry[];
}

const parseCache = new Map<string, ParseCacheEntry>();

export function clearParseCache(): void {
  parseCache.clear();
}

export async function parseJsonlFile(filePath: string): Promise<ParsedEntry[]> {
  try {
    const stats = await stat(filePath);
    const fileSizeBytes = stats.size;

    const cached = parseCache.get(filePath);
    if (
      cached &&
      cached.mtime === stats.mtimeMs &&
      cached.size === fileSizeBytes
    ) {
      debug(`[parse-cache] hit ${filePath}`);
      // LRU: move to most-recently-used end via delete+reinsert
      parseCache.delete(filePath);
      parseCache.set(filePath, cached);
      return cached.entries;
    }

    let entries: ParsedEntry[];
    if (fileSizeBytes > STREAMING_THRESHOLD_BYTES) {
      debug(
        `Using streaming parser for large file ${filePath} (${Math.round(fileSizeBytes / 1024)}KB)`,
      );
      entries = await parseJsonlFileStreaming(filePath);
    } else {
      entries = await parseJsonlFileInMemory(filePath);
    }

    debug(`Parsed ${entries.length} entries from ${filePath}`);

    // Large files are already streamed — retaining parsed entries pins memory. Skip cache.
    if (fileSizeBytes > PARSE_CACHE_SKIP_BYTES) {
      return entries;
    }

    // Evict stale entry for this path (mtime changed) before measuring capacity.
    parseCache.delete(filePath);
    // Evict LRU entry if at cap.
    if (parseCache.size >= PARSE_CACHE_MAX) {
      parseCache.delete(parseCache.keys().next().value!);
    }
    parseCache.set(filePath, {
      mtime: stats.mtimeMs,
      size: fileSizeBytes,
      entries,
    });
    return entries;
  } catch (error) {
    // [LAW:no-silent-failure] A transcript that doesn't exist yet is the
    // domain's genuine "no entries" (new session pre-first-write) — every
    // other read error propagates so the consuming provider classifies it
    // as a failed outcome and the payload boundary logs it. The old
    // catch-all-to-[] dressed EACCES/EIO as an empty session.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      debug(`Transcript not present yet: ${filePath}`);
      return [];
    }
    throw error;
  }
}

// Build a ParsedEntry from a full parsed JSONL line, retaining only the
// fields actually used downstream. The full parsed object (which includes
// message.content arrays with complete LLM response text) is discarded so
// the GC can reclaim that memory promptly instead of pinning it via raw.
// [LAW:one-source-of-truth] All callers go through here; no second parse path.
function makeEntry(parsed: Record<string, unknown>): ParsedEntry | null {
  if (!parsed.timestamp) return null;
  const msg = parsed.message as Record<string, unknown> | undefined;
  const usage = msg?.usage as UsageCounts | undefined;
  // Project only the first content block's `type` scalar; the array (full LLM
  // text) is never retained. Text content (a bare string) has no block type.
  const content = msg?.content;
  const firstBlock =
    Array.isArray(content) && typeof content[0] === "object" && content[0]
      ? (content[0] as { type?: unknown })
      : undefined;
  return {
    timestamp: new Date(parsed.timestamp as string),
    type: typeof parsed.type === "string" ? parsed.type : undefined,
    message: msg
      ? {
          id: typeof msg.id === "string" ? msg.id : undefined,
          model: typeof msg.model === "string" ? msg.model : undefined,
          usage,
          role: typeof msg.role === "string" ? msg.role : undefined,
          type: typeof msg.type === "string" ? msg.type : undefined,
          firstContentType:
            typeof firstBlock?.type === "string" ? firstBlock.type : undefined,
        }
      : undefined,
    costUSD: typeof parsed.costUSD === "number" ? parsed.costUSD : undefined,
    isSidechain: parsed.isSidechain === true,
    raw: {
      model: typeof parsed.model === "string" ? parsed.model : undefined,
      message: msg
        ? {
            id: typeof msg.id === "string" ? msg.id : undefined,
            model: typeof msg.model === "string" ? msg.model : undefined,
            usage,
          }
        : undefined,
      requestId:
        typeof parsed.requestId === "string" ? parsed.requestId : undefined,
    },
  };
}

// [LAW:one-source-of-truth] The one line→entry loop. Both the whole-file parse
// and the incremental append reader frame their text into lines through here, so
// a malformed-line policy or a projected field can never diverge between the two.
function parseJsonlLines(text: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = makeEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch (parseError) {
      debug(`Failed to parse JSONL line: ${parseError}`);
      continue;
    }
  }
  return entries;
}

async function parseJsonlFileInMemory(
  filePath: string,
): Promise<ParsedEntry[]> {
  const content = await readFile(filePath, "utf-8");
  return parseJsonlLines(content);
}

// A byte cursor into an append-only transcript: the offset consumed through the
// last complete line, the mtime observed at that read, and the inode. The store
// keys its per-file fold by this — `offset` bounds the next read to only what's
// new; `mtimeMs` lets an unchanged file skip the read entirely; `ino` detects a
// rewrite (a rename-based /compact swaps the inode) so the fold resets instead
// of splicing new bytes onto a stale prefix.
export interface TranscriptCursor {
  readonly offset: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

// [LAW:dataflow-not-control-flow][LAW:one-source-of-truth] Read only the entries
// appended to an append-only transcript since `prior`. The returned `entries`
// are TRANSIENT — the caller folds them into its own compact aggregate and drops
// them, so this reader (unlike the retained parseCache) pins no O(file) memory:
// its cost is O(bytes appended since last render), which is the whole point.
//
// A partial trailing line (a render observing the file mid-write, before its
// newline) is NOT consumed: the cursor advances only through the last complete
// line, so the partial line is re-read intact once its newline lands. Cutting at
// a newline also guarantees clean UTF-8 boundaries (0x0A is never a continuation
// byte), so no multibyte codepoint is split across reads.
//
// `reset` (from readAppended) means the file shrank/was rewritten (a /compact):
// `entries` then cover the whole new file from offset 0 and the caller discards
// its prior fold for this file. Absent/failed pass straight through.
export async function readAppendedEntries(
  filePath: string,
  prior: TranscriptCursor | undefined,
): Promise<
  Outcome<{ entries: ParsedEntry[]; cursor: TranscriptCursor; reset: boolean }>
> {
  const r = await readAppended(
    filePath,
    prior === undefined ? undefined : { offset: prior.offset, ino: prior.ino },
  );
  if (r.kind !== "ok") return r;
  const { buf, start, mtimeMs, ino, reset } = r.value;
  // Consume only through the last newline; a trailing partial line waits.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) {
    return ok({ entries: [], cursor: { offset: start, mtimeMs, ino }, reset });
  }
  const entries = parseJsonlLines(
    buf.subarray(0, lastNl + 1).toString("utf-8"),
  );
  return ok({
    entries,
    cursor: { offset: start + lastNl + 1, mtimeMs, ino },
    reset,
  });
}

async function parseJsonlFileStreaming(
  filePath: string,
): Promise<ParsedEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: ParsedEntry[] = [];
    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return;

      try {
        const entry = makeEntry(JSON.parse(trimmedLine));
        if (entry) entries.push(entry);
      } catch (parseError) {
        debug(`Failed to parse JSONL line: ${parseError}`);
      }
    });

    rl.on("close", () => {
      resolve(entries);
    });

    rl.on("error", (error) => {
      debug(`Streaming parser error for ${filePath}:`, error);
      reject(error);
    });

    fileStream.on("error", (error) => {
      debug(`File stream error for ${filePath}:`, error);
      reject(error);
    });
  });
}

interface FileStat {
  filePath: string;
  mtime: Date;
}

async function statFile(filePath: string): Promise<FileStat | null> {
  try {
    const mtime = await getFileModificationDate(filePath);
    return mtime ? { filePath, mtime } : null;
  } catch {
    return null;
  }
}

async function collectProjectFiles(
  projectPath: string,
  fileFilter?: (filePath: string, modTime: Date) => boolean,
): Promise<FileStat[]> {
  try {
    const entries = await readdir(projectPath, { withFileTypes: true });

    const sessionFiles = entries
      .filter((e) => !e.isDirectory() && e.name.endsWith(".jsonl"))
      .map((e) => statFile(join(projectPath, e.name)));

    const subagentFiles = entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const subagentsDir = join(projectPath, e.name, "subagents");
        try {
          const files = await readdir(subagentsDir);
          return files
            .filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
            .map((f) => statFile(join(subagentsDir, f)));
        } catch {
          return [];
        }
      });

    const [sessionResults, subagentResults] = await Promise.all([
      Promise.all(sessionFiles),
      Promise.all(subagentFiles).then((nested) => Promise.all(nested.flat())),
    ]);

    return [...sessionResults, ...subagentResults].filter(
      (s): s is FileStat =>
        s !== null && (!fileFilter || fileFilter(s.filePath, s.mtime)),
    );
  } catch (dirError) {
    debug(`Failed to read project directory ${projectPath}:`, dirError);
    return [];
  }
}

/**
 * Loads entries from Claude projects with deterministic deduplication.
 * @param timeFilter Optional filter to apply based on timestamp
 * @param fileFilter Optional filter to apply based on file path and modification time
 * @param sortFiles Whether to sort files by modification time
 * @returns Deduplicated entries sorted by timestamp
 * @note Sorts entries by timestamp before deduplication to ensure consistent
 *       duplicate selection. Otherwise, parallel file loading causes race conditions
 *       where different duplicates are kept on each run, leading to flickering values.
 */
export async function loadEntriesFromProjects(
  timeFilter?: (entry: ParsedEntry) => boolean,
  fileFilter?: (filePath: string, modTime: Date) => boolean,
  sortFiles = false,
): Promise<ParsedEntry[]> {
  const claudePaths = getClaudePaths();
  const projectPaths = await findProjectPaths(claudePaths);
  const processedHashes = new Set<string>();

  const allFilesPromises = projectPaths.map((projectPath) =>
    collectProjectFiles(projectPath, fileFilter),
  );

  const allFileResults = await Promise.all(allFilesPromises);
  const allFilesWithMtime = allFileResults
    .flat()
    .filter((file): file is { filePath: string; mtime: Date } => file !== null);

  if (sortFiles) {
    allFilesWithMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }

  const allFiles = allFilesWithMtime.map((file) => file.filePath);

  const entries: ParsedEntry[] = [];

  const filePromises = allFiles.map(async (filePath) => {
    const fileEntries = await parseJsonlFile(filePath);
    return fileEntries.filter((entry) => !timeFilter || timeFilter(entry));
  });

  const fileResults = await Promise.all(filePromises);
  for (const fileEntries of fileResults) {
    entries.push(...fileEntries);
  }

  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const deduplicatedEntries: ParsedEntry[] = [];
  for (const entry of entries) {
    const uniqueHash = createUniqueHash(entry);
    if (uniqueHash && processedHashes.has(uniqueHash)) {
      continue;
    }
    if (uniqueHash) {
      processedHashes.add(uniqueHash);
    }
    deduplicatedEntries.push(entry);
  }

  return deduplicatedEntries;
}
