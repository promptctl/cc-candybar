// [LAW:no-silent-failure] A per-session file whose write fails is never silent:
// every bar says the file is behind what the daemon holds, in the same words
// whichever store it is and however its write was made, until a write lands.
// Each case makes a real storage's write fail and reads the viewer of a bar.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { click, linkTo, render } from "../../helpers/daemon-e2e";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import type { IsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { readDiagnostics } from "../../helpers/diagnostics-viewer";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";
import { until } from "../../../scripts/lib/until";
import { fileHistoryStorage } from "../../../src/daemon/history-file";
import { writeAtomic } from "../../../src/utils/atomic-write";
import { SESSION_BOOK_FILE } from "../../../src/daemon/session-book";
import {
  SESSION_STATE_FILE,
  SessionFile,
} from "../../../src/daemon/session-state-file";
import { sessionStatePath } from "../../../src/daemon/paths";
import { hostOf } from "../../../scripts/lib/host";

jest.setTimeout(60_000);

const CONFIG = {
  globals: { padding: 1 },
  actions: {
    padUp: { set: "padding", min: 0, max: 16, by: 1 },
    keep: { save: true },
  },
  segments: {
    shown: { template: "PAD={{ .padding.effective }}" },
    ctl: {
      template: '{{ action "padUp" "[pad+]" }} {{ action "keep" "[keep]" }}',
    },
  },
  root: { h: ["shown", "ctl"] },
};

let isolated: IsolatedDaemonEnv;
let daemon: InWorkerDaemon | undefined;
let project: string;
beforeEach(() => {
  isolated = prepareIsolatedDaemonEnv("cc-candybar-store-behind");
  project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-store-behind-project-")),
  );
  const config = path.join(
    isolated.env.XDG_CONFIG_HOME!,
    "cc-candybar",
    "config.json5",
  );
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify(CONFIG));
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  isolated.removeTmpDirs();
  fs.rmSync(project, { recursive: true, force: true });
});

// What a refused disk says; each write of a test's own fails or lands as the
// case sets, at the step that writes the bytes. As a real refusal does, each
// attempt's message names a staged file of its own.
const DISK_FULL = "ENOSPC: no space left on device";
interface Disk {
  value: boolean;
  attempts: number;
}
const refusal = (disk: Disk): Error => {
  disk.attempts += 1;
  return Object.assign(
    new Error(DISK_FULL + ", open 'file." + disk.attempts + ".tmp'"),
    { code: "ENOSPC" },
  );
};
const refusing = (disk: Disk) => async (): Promise<void> => {
  if (disk.value) throw refusal(disk);
};
const publishRefusing =
  (disk: Disk): typeof writeAtomic =>
  (file, text, mode) => {
    if (disk.value) throw refusal(disk);
    writeAtomic(file, text, mode);
  };

// The messages a bar's viewer shows, each whole and without its wrapping.
const said = async (sid: string): Promise<string[]> => {
  const bar = await render(daemon!, sid, project);
  return (await readDiagnostics(daemon!, sid, project, bar)).map((p) =>
    p.text.replace(/\s/g, ""),
  );
};
const BEHIND = "isbehindwhatthisdaemonholds";
const behindOn = async (sid: string): Promise<string[]> =>
  (await said(sid)).filter((m) => m.includes(BEHIND));

const clickOn = async (sid: string, text: string): Promise<void> =>
  click(daemon!, linkTo(await render(daemon!, sid, project), text));

const bare = (text: string) => text.replace(/\s/g, "");

describe("a per-session file whose write fails", () => {
  test("stands behind on every bar, in the same words for the picks, the book and the history, until a write lands", async () => {
    const picksFile = sessionStatePath(hostOf(isolated.env));
    const bookFile = path.join(path.dirname(picksFile), "session-book.json");
    const historyFile = path.join(project, "settings-history.json");
    const refused = { value: true, attempts: 0 };
    const historyRefused = { value: true, attempts: 0 };
    daemon = startDaemon(isolated.env, {
      profile: (log) => ({
        session: new SessionFile(
          SESSION_STATE_FILE,
          picksFile,
          systemTimekeeper,
          0,
          log,
          refusing(refused),
        ),
        history: fileHistoryStorage(
          historyFile,
          log,
          publishRefusing(historyRefused),
        ),
      }),
      sessionBook: (log) =>
        new SessionFile(
          SESSION_BOOK_FILE,
          bookFile,
          systemTimekeeper,
          0,
          log,
          refusing(refused),
        ),
    });

    // A pick writes the picks, a save writes the history, and every request
    // writes the book.
    await clickOn("behind-a", "[pad+]");
    await clickOn("behind-a", "[keep]");

    // Every bar, not only the session that wrote.
    let rows: string[] = [];
    await until(
      async () => (rows = await behindOn("behind-b")).length === 3,
      () =>
        `three files behind on another session's bar, saw:\n${rows.join("\n")}`,
    );
    const rowOf = (store: string, file: string): string => {
      const [row, ...more] = rows.filter((r) => r.includes(bare(file)));
      expect(more).toEqual([]);
      expect(row).toContain(bare(store));
      return row!;
    };
    const picks = rowOf("Sessionpicks", picksFile);
    const book = rowOf("Sessionbook", bookFile);
    const history = rowOf("Settingshistory", historyFile);
    expect(picks).toContain(bare(DISK_FULL));
    expect(book).toContain(bare(DISK_FULL));
    // The history's write is refused at once, not behind, and is said once, as
    // the row and nothing beside.
    expect(history).toContain(bare(DISK_FULL));
    expect(
      (await said("behind-b")).filter((m) => m.includes("couldnotbetaken")),
    ).toEqual([]);

    // The same words whichever store and whichever write: what differs is
    // the store, the file and the reason.
    const normalized = (row: string, store: string, file: string) =>
      row
        .replace(bare(store), "STORE")
        .replace(bare(file), "FILE")
        .replace(/—.*$/, "");
    expect(normalized(book, "Sessionbook", bookFile)).toBe(
      normalized(picks, "Sessionpicks", picksFile),
    );
    expect(normalized(history, "Settingshistory", historyFile)).toBe(
      normalized(picks, "Sessionpicks", picksFile),
    );

    // It stands, as it was said, while the writes keep failing: a refusal of
    // the same cause names another staged file, and says nothing new.
    const standing = [...rows].sort();
    const failed = refused.attempts;
    await clickOn("behind-a", "[pad+]");
    await until(
      async () => refused.attempts > failed,
      () => "another write of the picks was refused",
    );
    expect([...(await behindOn("behind-b"))].sort()).toEqual(standing);

    // A write that lands clears its own file's row alone.
    refused.value = false;
    await clickOn("behind-a", "[pad+]");
    await until(
      async () => {
        rows = await behindOn("behind-b");
        return rows.every((r) => !r.includes(bare(picksFile)));
      },
      () => `the picks row cleared once its write landed, saw ${rows.length}`,
    );
    expect(rows.some((r) => r.includes(bare(historyFile)))).toBe(true);

    // The history's row clears when its own write lands.
    historyRefused.value = false;
    await clickOn("behind-a", "[keep]");
    await until(
      async () => {
        rows = await behindOn("behind-b");
        return rows.every((r) => !r.includes(bare(historyFile)));
      },
      () => `the history row cleared once its write landed, saw ${rows.length}`,
    );
  });
});
