import {
  SessionFile,
  SESSION_STATE_FILE,
} from "../../src/daemon/session-state-file";
import { sessionIdOf } from "../../src/daemon/foundations/session-id";
import {
  publishByRenameAsync,
  type RenameFiles,
} from "../../src/utils/atomic-write";
import { heldClock } from "../helpers/held-clock";

const S1 = sessionIdOf("s1"),
  S2 = sessionIdOf("s2");
const file = "session-state.json";
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
};

// The real publisher stages, renames and cleans up on this filesystem. The
// first rename waits until the new snapshot is queued behind the old one.
const setup = () => {
  const clock = heldClock(new Date(0));
  const reached = gate(),
    release = gate();
  const files = new Map<string, string>();
  let renames = 0;
  const disk: RenameFiles = {
    async writeFile(at, body) {
      if (files.has(at)) throw new Error("exclusive write to existing file");
      files.set(at, String(body));
    },
    async chmod(at) {
      if (!files.has(at)) throw new Error("chmod of missing file");
    },
    async rename(from, to) {
      if (++renames === 1) {
        reached.open();
        await release.promise;
      }
      const body = files.get(from);
      if (body === undefined) throw new Error("rename of missing file");
      files.set(to, body);
      files.delete(from);
    },
    async rm(at) {
      files.delete(at);
    },
  };
  const store = new SessionFile(
    SESSION_STATE_FILE,
    file,
    clock,
    10,
    undefined,
    (at, body) => publishByRenameAsync(at, body, 0o600, undefined, disk),
  );
  return { store, disk, clock, files, reached, release };
};

test.each([false, true])(
  "flush behind a held rename preserves newer session values (refused=%s)",
  async (refused) => {
    const { clock, store, disk, files, reached, release } = setup();
    const sessions = new Map([[S1, { theme: "old" }]]);
    store.save(sessions);
    clock.advance(10);
    await reached.promise;
    expect([...files.keys()]).toEqual([expect.stringMatching(/\.tmp$/)]);
    sessions.set(S1, { theme: "new" });
    sessions.set(S2, { theme: "other" });
    store.save(sessions);
    const landing = store.flush();
    if (refused)
      jest.spyOn(disk, "rename").mockRejectedValueOnce(new Error("ENOSPC"));
    release.open();
    if (refused) {
      await expect(landing).rejects.toThrow("ENOSPC");
      expect([...files.keys()]).toEqual([file]);
      expect(JSON.parse(files.get(file)!)).toEqual({ s1: { theme: "old" } });
      await store.flush();
    } else {
      await landing;
    }
    expect([...files.keys()]).toEqual([file]);
    expect(JSON.parse(files.get(file)!)).toEqual({
      s1: { theme: "new" },
      s2: { theme: "other" },
    });
    expect(clock.pending()).toBe(0);
  },
);
