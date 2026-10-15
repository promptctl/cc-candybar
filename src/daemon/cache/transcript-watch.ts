import { watch, statSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";

import { nearestWatchTarget } from "../../utils/watch-target";

// The writes a Claude Code directory's sessions make to their main
// transcripts, observed as they happen. A session that renders a statusline
// tells the usage store about its own transcript on every render; one that
// never renders (headless `claude -p`, the Agent SDK) tells it nothing, so the
// store learns of its work here instead — from the filesystem, without
// rescanning the tree (brandon-unfiled-3248.7xp).

// A session's main transcript is `projects/<project>/<session>.jsonl`. Agent
// sidechains sit deeper (`<project>/<session>/subagents/agent-*.jsonl`) and are
// folded with their session when its main transcript moves, so they are not
// reported on their own.
export interface TranscriptWrite {
  readonly sessionId: string;
  readonly path: string;
}

// [LAW:effects-at-boundaries] The pure reading of one watch event: which main
// transcript `filename` (relative to the watched `projects/` directory, as a
// recursive fs.watch reports it) names, or null for anything else in the tree.
export function transcriptWriteOf(
  projectsDir: string,
  filename: string,
): TranscriptWrite | null {
  const parts = filename.split(sep);
  const name = parts[1];
  if (parts.length !== 2 || name === undefined || !name.endsWith(".jsonl")) {
    return null;
  }
  return {
    sessionId: name.slice(0, -".jsonl".length),
    path: join(projectsDir, filename),
  };
}

export interface TranscriptWatch {
  close(): void;
}

// Watch one Claude Code directory's transcripts. `onWrite` receives each main
// transcript written; `onLost` is called (at most once) when the watch stops
// covering the tree — the OS reported an error, or `projects/` appeared where
// there was none — after which nothing more is reported and every write from
// then on goes unseen until the caller watches again.
//
// [LAW:dataflow-not-control-flow] An absent `projects/` is watched like any
// path that may not exist yet (`nearestWatchTarget`): through its nearest
// existing ancestor, for the name that leads to it, so its creation ends the
// watch and the caller's next look begins with it present.
//
// [LAW:no-silent-failure] A watch the OS refuses (EMFILE, ENOSPC, EACCES)
// throws out of here: the caller cannot know what it would have missed.
export function watchTranscripts(
  claudeDir: string,
  onWrite: (write: TranscriptWrite) => void,
  onLost: (reason: string) => void,
): TranscriptWatch {
  const projectsDir = join(claudeDir, "projects");
  let open = true;
  const lose = (reason: string): void => {
    if (!open) return;
    open = false;
    watcher.close();
    onLost(reason);
  };
  const watcher: FSWatcher = isDirectory(projectsDir)
    ? watch(projectsDir, { persistent: false, recursive: true }, (_e, f) => {
        const write = f === null ? null : transcriptWriteOf(projectsDir, f);
        if (open && write !== null) onWrite(write);
      })
    : watchForAppearance(projectsDir, () => lose(`${projectsDir} appeared`));
  watcher.on("error", (e) => lose(`${projectsDir}: ${e.message}`));
  return {
    close: () => {
      open = false;
      watcher.close();
    },
  };
}

function watchForAppearance(path: string, appeared: () => void): FSWatcher {
  const { dir, name } = nearestWatchTarget(path);
  return watch(dir, { persistent: false }, (_e, f) => {
    if (f === name) appeared();
  });
}

// Absent is the one answer that is not an error; a stat the OS refuses throws.
function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}
