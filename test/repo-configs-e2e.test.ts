import type { Frame } from "../src/render/frame";
// [LAW:verifiable-goals] A cloned repository's cc-candybar config runs only
// once the user approves it, by one click in the bar, and the answer holds:
// across a daemon restart and across edits of the file, as Claude Code's
// answer for a project's MCP servers does. Measured the way it would be
// exploited: the daemon's own request handling, a project config whose
// `shell` variable leaves a marker on disk when it runs.

import { textOf } from "../src/render/frame";
import { linkUrls } from "./helpers/frame";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findUrl, render, renderUntil, sendClick } from "./helpers/daemon-e2e";
import type { DaemonTarget } from "./helpers/daemon-wire";
import { startDaemon, type InWorkerDaemon } from "./helpers/in-worker-daemon";
import {
  prepareIsolatedDaemonEnv,
  type IsolatedDaemonEnv,
} from "./helpers/spawn-isolated-daemon";
import { VERB_REPO_CONFIG } from "../src/click/wire";
import { logPath } from "../src/daemon/paths";
import { repoConfigs, repoConfigsPath } from "../src/daemon/repo-configs";
import { stateDir } from "../src/daemon/paths";
import {
  indicatorOf,
  readDiagnostics,
  type ViewerPage,
} from "./helpers/diagnostics-viewer";
import { until } from "./helpers/until";

jest.setTimeout(60_000);

const USER_CONFIG = {
  segments: { mine: { template: "USERSEG", bg: "surface", fg: "foreground" } },
  root: { h: ["mine"] },
};

// A project config whose variable runs a program as soon as it loads.
function repoConfig(marker: string, label: string): string {
  return JSON.stringify({
    variables: {
      ran: {
        kind: "shell",
        command: `touch ${marker}; echo ran`,
        parse: { text: true },
        cache: { never: true },
        default: "",
      },
    },
    segments: {
      repo: {
        template: `${label}{{ .ran }}`,
        bg: "surface",
        fg: "foreground",
      },
    },
    root: { h: ["repo"] },
  });
}

// An answer's click reloads the session's config before it replies, as
// save's does, so the next render draws the answered config: approving
// compiles the repository's config first, which the source daemon can take
// seconds over on a loaded machine.
const ANSWER_REPLY_MS = 20_000;

// The question the bar asks of a session, read in the viewer its indicator
// opens: the page whose message asks it, or none.
async function questionOf(
  target: DaemonTarget,
  sessionId: string,
  cwd: string,
  bar: Frame,
): Promise<ViewerPage | undefined> {
  const pages = await readDiagnostics(target, sessionId, cwd, bar);
  return pages.find((p) => p.text.includes("a cc-candybar config for"));
}

// The rendered link that answers `answer` for a repository.
function answerUrl(rendered: Frame, answer: string): string {
  const url = findUrl(linkUrls(rendered), (effects) =>
    effects.some((e) => e.verb === VERB_REPO_CONFIG && e.args[2] === answer),
  );
  if (url === undefined) throw new Error(`no ${answer} link in:\n${textOf(rendered)}`);
  return url;
}

describe("a repository's config waits for the user's one answer", () => {
  let isolated: IsolatedDaemonEnv;
  let daemon: InWorkerDaemon;
  let project: string;
  let marker: string;
  let projectFile: string;

  beforeEach(() => {
    isolated = prepareIsolatedDaemonEnv("cc-candybar-repo-e2e");
    const configDir = path.join(isolated.env.XDG_CONFIG_HOME!, "cc-candybar");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json5"),
      JSON.stringify(USER_CONFIG),
    );
    project = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-repo-e2e-project-")),
    );
    marker = path.join(project, "ran.marker");
    projectFile = path.join(project, ".cc-candybar.json5");
    fs.writeFileSync(projectFile, repoConfig(marker, "REPOSEG"));
  });

  afterEach(async () => {
    await daemon?.stop();
    isolated.removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  });

  const start = (): void => {
    daemon = startDaemon(isolated.env);
  };
  const draw = (sid: string): Promise<Frame> =>
    render(daemon, sid, project);

  test("unanswered: nothing runs, the user's config draws, and the bar asks", async () => {
    start();
    const bar = await draw("repo-ask");
    const text = textOf(bar);
    expect(text).toContain("USERSEG");
    expect(text).not.toContain("REPOSEG");
    // The question is a message the indicator offers, its answers in it.
    const question = await questionOf(daemon, "repo-ask", project, bar);
    expect(question!.text).toContain(`a cc-candybar config for ${project}`);
    const rendered = question!.rendered;
    expect(fs.existsSync(marker)).toBe(false);
    // [LAW:nothing-unseen] The load says which repository it left waiting.
    const loadedLine = ` awaiting=${project} declined=- `;
    await until(
      () =>
        fs
          .readFileSync(logPath(isolated.env), "utf8")
          .split("\n")
          .some((l) => l.includes("config loaded ") && l.includes(loadedLine)),
      "the config loaded event naming the waiting repository",
    );

    // A link whose signature is not the bar's is refused, and records nothing.
    const approve = answerUrl(rendered, "approved");
    const forged = approve.replace(/[0-9a-f]{64}/, "0".repeat(64));
    expect(forged).not.toBe(approve);
    const refused = await sendClick(daemon, forged);
    expect(refused.ok).toBe(false);
    expect(fs.existsSync(repoConfigsPath(stateDir(isolated.env)))).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("approve: the config loads and runs, and stays approved across a restart and an edit", async () => {
    start();
    const asked = await questionOf(
      daemon,
      "repo-yes",
      project,
      await draw("repo-yes"),
    );
    const resp = await sendClick(
      daemon,
      answerUrl(asked!.rendered, "approved"),
      ANSWER_REPLY_MS,
    );
    expect(resp.ok).toBe(true);
    const approved = await renderUntil(
      daemon,
      "repo-yes",
      project,
      (r) => textOf(r).includes("REPOSEGran"),
      "the approved repository's config",
    );
    expect(
      await questionOf(daemon, "repo-yes", project, approved),
    ).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(true);

    // A restart reads the answer back from the state directory.
    await daemon.stop();
    start();
    const restartedBar = await draw("repo-yes-2");
    expect(textOf(restartedBar)).toContain("REPOSEG");
    expect(
      await questionOf(daemon, "repo-yes-2", project, restartedBar),
    ).toBeUndefined();

    // An edit reloads into the edited config, and never asks again.
    fs.writeFileSync(projectFile, repoConfig(marker, "EDITED"));
    const edited = await renderUntil(
      daemon,
      "repo-yes-2",
      project,
      (r) => textOf(r).includes("EDITED"),
      "the edited config",
    );
    expect(
      await questionOf(daemon, "repo-yes-2", project, edited),
    ).toBeUndefined();
  });

  test("decline: the user's config draws, nothing runs, and nothing asks again", async () => {
    start();
    const asked = await questionOf(
      daemon,
      "repo-no",
      project,
      await draw("repo-no"),
    );
    const resp = await sendClick(
      daemon,
      answerUrl(asked!.rendered, "declined"),
      ANSWER_REPLY_MS,
    );
    expect(resp.ok).toBe(true);
    // The user's config draws nothing else to say, so no question is no
    // indicator at all.
    const declined = await renderUntil(
      daemon,
      "repo-no",
      project,
      (r) => indicatorOf(r) === null,
      "the bar without the question",
    );
    expect(textOf(declined)).toContain("USERSEG");
    expect(textOf(declined)).not.toContain("REPOSEG");

    await daemon.stop();
    start();
    const restartedBar = await draw("repo-no-2");
    expect(textOf(restartedBar)).toContain("USERSEG");
    expect(indicatorOf(restartedBar)).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("a worktree asks for its repository, and one answer there covers the repository and supersedes the worktree's own", async () => {
    const git = (...args: string[]): void => {
      execFileSync("git", args, { stdio: "ignore" });
    };
    git("init", "-q", project);
    git(
      "-C",
      project,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    );
    const wt = `${project}-wt`;
    git("-C", project, "worktree", "add", "-q", "--detach", wt);
    const wtMarker = path.join(wt, "ran.marker");
    fs.writeFileSync(
      path.join(wt, ".cc-candybar.json5"),
      repoConfig(wtMarker, "WTSEG"),
    );
    // An answer kept under the worktree's own path, before answers were kept
    // by repository: it disagrees with the repository's, so it asks.
    repoConfigs(stateDir(isolated.env)).update(() => ({
      [project]: "declined",
      [wt]: "approved",
    }));
    try {
      start();
      const asked = await questionOf(
        daemon,
        "repo-wt",
        wt,
        await render(daemon, "repo-wt", wt),
      );
      expect(asked!.text).toContain(`a cc-candybar config for ${project}`);
      const resp = await sendClick(
        daemon,
        answerUrl(asked!.rendered, "approved"),
        ANSWER_REPLY_MS,
      );
      expect(resp.ok).toBe(true);
      await renderUntil(
        daemon,
        "repo-wt",
        wt,
        (r) => textOf(r).includes("WTSEGran"),
        "the worktree's config, approved through its repository",
      );
      // [LAW:nothing-unseen] The answer says which entries it superseded.
      await until(
        () =>
          fs
            .readFileSync(logPath(isolated.env), "utf8")
            .includes(
              `repo-config: ${project} approved superseded=${wt} absent=- unchecked=- `,
            ),
        "the repo-config event naming the superseded worktree entry",
      );
      expect(repoConfigs(stateDir(isolated.env)).read()).toEqual({
        kind: "ok",
        value: { [project]: "approved" },
      });
      // The main worktree is approved by the same answer.
      const main = await draw("repo-main");
      expect(textOf(main)).toContain("REPOSEG");
      expect(indicatorOf(main)).toBeNull();
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
