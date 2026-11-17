// The host's book of each session's durable context: what its file keeps and
// reads back, which request it keeps, and what a click finds in it.

import { PROTOCOL_VERSION } from "../../src/daemon/foundations/protocol";
import type { RenderRequest } from "../../src/daemon/foundations/protocol";
import {
  sessionIdOf,
  type SessionId,
} from "../../src/daemon/foundations/session-id";
import { checkRenderRequest } from "../../src/daemon/render-checkpoint";
import {
  SESSION_BOOK_FILE,
  SessionBook,
  type SessionBookStorage,
} from "../../src/daemon/session-book";
import type {
  CheckedRenderRequest,
  DurableContext,
} from "../../src/renderer-interface/request-context";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");

// A statusline request of `session` from `dir`, across the host's checkpoint.
function request(
  session: string,
  dir = "/p",
  hints: Partial<RenderRequest> = {},
): CheckedRenderRequest {
  const checked = checkRenderRequest(
    {
      v: PROTOCOL_VERSION,
      kind: "render",
      hookData: {
        hook_event_name: "Status",
        session_id: session,
        transcript_path: `${dir}/transcript.jsonl`,
        cwd: dir,
        model: { id: "claude-opus-4-7", display_name: "Opus 4.7" },
        workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
      },
      args: ["cc-candybar"],
      cwd: dir,
      ...hints,
    },
    { firstSightOfUnknownHookField: () => false },
    () => {},
    "/nowhere/home",
  );
  if (!checked.ok) throw new Error(checked.problems.join("; "));
  return checked.req;
}

const durable = (dir: string): DurableContext => ({
  origin: { projectDir: dir, cwd: dir, target: { source: "search" } },
});

// A book's file in memory: what it holds when the book loads, and every save.
function storage(held: ReadonlyMap<SessionId, DurableContext> = new Map()) {
  const saves: Readonly<Record<SessionId, DurableContext>>[] = [];
  let flushes = 0;
  const storage: SessionBookStorage = {
    load: () => held,
    save: (snapshot) => void saves.push(snapshot),
    flush: () => void (flushes += 1),
  };
  return { storage, saves, flushes: () => flushes };
}

// What a load of the file's text gives back.
const roundTrip = (value: DurableContext): DurableContext | null =>
  SESSION_BOOK_FILE.parse(
    JSON.parse(JSON.stringify(SESSION_BOOK_FILE.record(value))),
  );

describe("the book's file", () => {
  test.each<DurableContext>([
    durable("/p"),
    {
      origin: {
        projectDir: "/p",
        cwd: "/p/sub",
        target: { source: "argument", path: "/x.json5" },
      },
    },
    {
      origin: {
        projectDir: "/p",
        cwd: "/p",
        target: { source: "environment", path: "/x.json5" },
      },
      claudeConfigDir: "/u/.claude-x",
    },
  ])("%j reads back as it was kept", (value) => {
    expect(roundTrip(value)).toEqual(value);
  });

  test("a newer build's source beside a file leaves the file, its source unknown", () => {
    expect(
      SESSION_BOOK_FILE.parse({
        projectDir: "/p",
        cwd: "/p",
        configFile: "/x.json5",
        source: "workspace",
      }),
    ).toEqual({
      origin: {
        projectDir: "/p",
        cwd: "/p",
        target: { source: "unknown", path: "/x.json5" },
      },
    });
  });

  test.each([
    ["no record", null],
    ["no configFile", { projectDir: "/p", cwd: "/p", source: "search" }],
    ["a relative project", { projectDir: "p", cwd: "/p", configFile: null }],
    [
      "a relative config file",
      { projectDir: "/p", cwd: "/p", configFile: "x.json5", source: "argument" },
    ],
    [
      "a relative Claude Code directory",
      { projectDir: "/p", cwd: "/p", configFile: null, claudeConfigDir: "c" },
    ],
  ])("%s is refused", (_name, value) => {
    expect(SESSION_BOOK_FILE.parse(value)).toBeNull();
  });

  test("what a client reports now is never kept", () => {
    const req = request("s1", "/p", {
      tmux: { socket: "/tmp/tmux-1/default", pane: "%3", truecolor: null },
      termCols: 120,
      claudeConfigDir: "/u/.claude-x",
    });
    const { saves, storage: kept } = storage();
    new SessionBook(kept).heard(req);
    expect(
      JSON.parse(
        JSON.stringify(SESSION_BOOK_FILE.record(saves.at(-1)![S1]!)),
      ),
    ).toEqual({
      projectDir: "/p",
      cwd: "/p",
      configFile: null,
      source: "search",
      claudeConfigDir: "/u/.claude-x",
    });
  });
});

describe("the book", () => {
  test("a click finds a session heard since the start live, and one read back with no live part", () => {
    const book = new SessionBook(storage(new Map([[S2, durable("/q")]])).storage);
    book.load();
    const req = request("s1");
    book.heard(req);
    expect(book.contextOf(S1, req)).toEqual({
      session: S1,
      durable: durable("/p"),
      live: req,
    });
    expect(book.contextOf(S2, null)).toEqual({
      session: S2,
      durable: durable("/q"),
      live: null,
    });
    expect(book.contextOf(sessionIdOf("never"), null)).toBeNull();
  });

  test("a session heard before the load keeps what it said over what the file holds", () => {
    const book = new SessionBook(
      storage(new Map([[S1, durable("/old")], [S2, durable("/q")]])).storage,
    );
    book.heard(request("s1", "/new"));
    book.load();
    expect(book.contextOf(S1, null)?.durable).toEqual(durable("/new"));
    expect(book.contextOf(S2, null)?.durable).toEqual(durable("/q"));
  });

  test("a request that says what the book holds is not saved again", () => {
    const { storage: kept, saves } = storage();
    const book = new SessionBook(kept);
    book.heard(request("s1", "/p", { termCols: 80 }));
    book.heard(request("s1", "/p", { termCols: 120 }));
    expect(saves).toHaveLength(1);
    book.heard(request("s1", "/q"));
    expect(saves.at(-1)).toEqual({ [S1]: durable("/q") });
  });

  test("the book holds its newest sessions and drops the oldest", () => {
    const { storage: kept, saves } = storage();
    const book = new SessionBook(kept);
    for (let i = 0; i <= 256; i += 1) book.heard(request(`s${i}`, `/p${i}`));
    expect(Object.keys(saves.at(-1)!)).toHaveLength(256);
    expect(book.contextOf(sessionIdOf("s0"), null)).toBeNull();
    expect(book.contextOf(sessionIdOf("s256"), null)?.durable).toEqual(
      durable("/p256"),
    );
  });

  test("a close flushes the file, and nothing heard after it is saved", () => {
    const { storage: kept, saves, flushes } = storage();
    const book = new SessionBook(kept);
    book.heard(request("s1"));
    book.close();
    expect(flushes()).toBe(1);
    book.heard(request("s2"));
    expect(saves).toHaveLength(1);
  });
});
