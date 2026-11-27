// [LAW:verifiable-goals] A per-session file the daemon cannot read is never
// lost and never silent: the bar the daemon draws says where its bytes are,
// or, when they could not be moved, that nothing is saved to it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { render } from "../../helpers/daemon-e2e";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import type { IsolatedDaemonEnv } from "../../../scripts/lib/daemon/isolated";
import { indicatorOf, readDiagnostics } from "../../helpers/diagnostics-viewer";
import { sessionStatePath } from "../../../src/daemon/paths";
import { hostOf } from "../../../scripts/lib/host";

jest.setTimeout(60_000);

let isolated: IsolatedDaemonEnv;
let daemon: InWorkerDaemon | undefined;
let project: string;
beforeEach(() => {
  isolated = prepareIsolatedDaemonEnv("cc-candybar-stored-state");
  project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-stored-state-project-")),
  );
});
afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  isolated.removeTmpDirs();
  fs.rmSync(project, { recursive: true, force: true });
});

// What the bar's viewer says, each message whole.
const said = async (sid: string): Promise<string[]> => {
  const bar = await render(daemon!, sid, project);
  return (await readDiagnostics(daemon!, sid, project, bar)).map((p) => p.text);
};

test("a session-state file that does not read is kept beside itself, and the bar says where", async () => {
  const file = sessionStatePath(hostOf(isolated.env));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  daemon = startDaemon(isolated.env);
  const pages = await said("stored-unread");
  const [aside] = fs
    .readdirSync(path.dirname(file))
    .filter((f) => f.startsWith("session-state.json.unread-"));
  expect(fs.readFileSync(path.join(path.dirname(file), aside!), "utf8")).toBe(
    "{ not json",
  );
  // The viewer wraps a long path, so the text is compared without its spaces.
  const unspaced = pages.map((p) => p.replace(/\s/g, ""));
  const page = unspaced.find((p) =>
    p.includes("thestorestartedagainfromempty"),
  );
  expect(page).toContain("Sessionpickscouldnotberead");
  expect(page).toContain(aside);
});

test("a file that can be neither read nor set aside stands on the bar as saving nothing", async () => {
  const file = sessionStatePath(hostOf(isolated.env));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(file, file);
  daemon = startDaemon(isolated.env);
  const pages = await said("stored-refused");
  expect(
    pages.find((p) => p.includes("ELOOP"))?.replace(/\s+/g, ""),
  ).toContain("andnothingissavedtoituntilthedaemonstartsagain");
  expect(fs.readlinkSync(file)).toBe(file);
  // It stands: a later bar still says it.
  expect(
    (await said("stored-refused-later")).some((p) => p.includes("ELOOP")),
  ).toBe(true);
});

test("a file that is not there says nothing", async () => {
  daemon = startDaemon(isolated.env);
  const bar = await render(daemon, "stored-missing", project);
  // A bar with nothing to say has no indicator to open.
  const pages =
    indicatorOf(bar) === null
      ? []
      : await readDiagnostics(daemon, "stored-missing", project, bar);
  expect(pages.some((p) => p.text.includes("could not be read"))).toBe(false);
});
