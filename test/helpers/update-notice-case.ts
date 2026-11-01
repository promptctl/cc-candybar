import type { Frame } from "../../src/render/frame";
// What the update notice's cases share, in a worker or on a real process: a
// checkout laid down in scratch, and the bar's messages read in its viewer.

import { linkUrls } from "./frame";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findUrl, render } from "./daemon-e2e";
import type { DaemonTarget } from "./daemon-wire";
import { readDiagnostics, type ViewerPage } from "./diagnostics-viewer";
import { until } from "./until";

const REPO_SRC = path.join(process.cwd(), "src");
const HOUR_S = 60 * 60;

// Every message a session's bar offers, each read in the viewer: a notice is
// one sentence however many rows it wrapped onto, so a page reads as flowed text.
export const pagesOf = async (
  sock: DaemonTarget,
  sessionId: string,
  cwd: string,
): Promise<ViewerPage[]> =>
  readDiagnostics(sock, sessionId, cwd, await render(sock, sessionId, cwd));
export const noticeOf = (pages: readonly ViewerPage[]): ViewerPage | undefined =>
  pages.find((p) => p.text.startsWith("⬆"));
export const hasNotice = (pages: readonly ViewerPage[]): boolean =>
  noticeOf(pages) !== undefined;
// [LAW:no-ambient-temporal-coupling] Reads the bar's messages until what is
// waited for shows, or fails naming the last messages read.
export async function pagesUntil(
  sock: DaemonTarget,
  sessionId: string,
  cwd: string,
  accepts: (pages: readonly ViewerPage[]) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<ViewerPage[]> {
  let last: ViewerPage[] = [];
  await until(
    async () => accepts((last = await pagesOf(sock, sessionId, cwd))),
    () => `${what}; last messages: ${JSON.stringify(last.map((p) => p.text))}`,
    timeoutMs,
  );
  return last;
}

export interface Scratch {
  readonly root: string;
  readonly projectDir: string;
  remove(): void;
}

type Source = "edited" | "real-with-bumped-mtimes" | "none";

function bumpMtimes(dir: string): void {
  const t = Date.now() / 1000 + HOUR_S;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) bumpMtimes(p);
    fs.lutimesSync(p, t, t);
  }
}

// A checkout-shaped directory holding a package.json naming the source's
// version, plus a project dir whose
// `.json5`/`.json` pair trips the collision detector so the render carries a
// per-config warning to order against.
export function scratchLayout(source: Source): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), '{ "version": "9.9.9" }\n');
  const src = path.join(root, "src");
  if (source === "edited") {
    fs.mkdirSync(src);
    fs.writeFileSync(
      path.join(src, "edited.ts"),
      "export const edited = true;\n",
    );
  }
  if (source === "real-with-bumped-mtimes") {
    fs.cpSync(REPO_SRC, src, { recursive: true });
    bumpMtimes(src);
  }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-bc-proj-"));
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json5"), "{}");
  fs.writeFileSync(path.join(projectDir, ".cc-candybar.json"), "{}");
  return {
    root,
    projectDir,
    remove: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

export const affordance = (raw: Frame, verb: string, key?: string): string => {
  const url = findUrl(linkUrls(raw), (effects) =>
    effects.some(
      (e) => e.verb === verb && (key === undefined || e.args[1] === key),
    ),
  );
  if (url === undefined)
    throw new Error(`no rendered affordance for ${verb} ${key ?? ""}`);
  return url;
};
