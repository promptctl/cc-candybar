// [LAW:verifiable-goals] A cloned repository's cc-candybar config runs only
// once the user approves it, by one click in the bar, and the answer holds:
// across a daemon restart and across edits of the file, as Claude Code's
// answer for a project's MCP servers does. Measured the way it would be
// exploited: a REAL daemon over a REAL socket, a project config whose
// `shell` variable leaves a marker on disk when it runs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findUrl,
  killAndWait,
  linkUrls,
  render,
  renderUntil,
  sendClick,
  stripAnsi,
} from "./helpers/daemon-e2e";
import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type IsolatedDaemonEnv,
  type RunningDaemon,
} from "./helpers/spawn-isolated-daemon";
import { VERB_REPO_CONFIG } from "../src/click/wire";
import { logPath } from "../src/daemon/paths";
import { repoConfigs, repoConfigsPath } from "../src/daemon/repo-configs";
import { stateDir } from "../src/daemon/paths";
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

// The rendered link that answers `answer` for a repository.
function answerUrl(rendered: string, answer: string): string {
  const url = findUrl(linkUrls(rendered), (effects) =>
    effects.some((e) => e.verb === VERB_REPO_CONFIG && e.args[2] === answer),
  );
  if (url === undefined) throw new Error(`no ${answer} link in:\n${rendered}`);
  return url;
}

describe("a repository's config waits for the user's one answer", () => {
  let isolated: IsolatedDaemonEnv;
  let daemon: RunningDaemon | undefined;
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
    if (daemon !== undefined) await killAndWait(daemon);
    daemon = undefined;
    isolated.removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  });

  const start = async (): Promise<void> => {
    daemon = await spawnDaemonWithEnv(isolated.env);
  };
  const draw = (sid: string): Promise<string> =>
    render(isolated.sockPath, sid, project);

  test("unanswered: nothing runs, the user's config draws, and the bar asks", async () => {
    await start();
    const rendered = await draw("repo-ask");
    // The strip wraps to the client's width: read it as one run of words.
    const text = stripAnsi(rendered).replace(/\s+/g, " ");
    expect(text).toContain("USERSEG");
    expect(text).not.toContain("REPOSEG");
    expect(text).toContain(`a cc-candybar config for ${project}`);
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
    const refused = await sendClick(isolated.sockPath, forged);
    expect(refused.ok).toBe(false);
    expect(fs.existsSync(repoConfigsPath(stateDir(isolated.env)))).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("approve: the config loads and runs, and stays approved across a restart and an edit", async () => {
    await start();
    const asked = await draw("repo-yes");
    const resp = await sendClick(
      isolated.sockPath,
      answerUrl(asked, "approved"),
      ANSWER_REPLY_MS,
    );
    expect(resp.ok).toBe(true);
    const approved = await renderUntil(
      isolated.sockPath,
      "repo-yes",
      project,
      (r) => stripAnsi(r).includes("REPOSEGran"),
      "the approved repository's config",
    );
    expect(stripAnsi(approved)).not.toContain("a cc-candybar config for");
    expect(fs.existsSync(marker)).toBe(true);

    // A restart reads the answer back from the state directory.
    await killAndWait(daemon!, "SIGTERM");
    await start();
    const restarted = stripAnsi(await draw("repo-yes-2"));
    expect(restarted).toContain("REPOSEG");
    expect(restarted).not.toContain("a cc-candybar config for");

    // An edit reloads into the edited config, and never asks again.
    fs.writeFileSync(projectFile, repoConfig(marker, "EDITED"));
    const edited = await renderUntil(
      isolated.sockPath,
      "repo-yes-2",
      project,
      (r) => stripAnsi(r).includes("EDITED"),
      "the edited config",
    );
    expect(stripAnsi(edited)).not.toContain("a cc-candybar config for");
  });

  test("decline: the user's config draws, nothing runs, and nothing asks again", async () => {
    await start();
    const asked = await draw("repo-no");
    const resp = await sendClick(
      isolated.sockPath,
      answerUrl(asked, "declined"),
      ANSWER_REPLY_MS,
    );
    expect(resp.ok).toBe(true);
    const declined = await renderUntil(
      isolated.sockPath,
      "repo-no",
      project,
      (r) => !stripAnsi(r).includes("a cc-candybar config for"),
      "the bar without the question",
    );
    expect(stripAnsi(declined)).toContain("USERSEG");
    expect(stripAnsi(declined)).not.toContain("REPOSEG");

    await killAndWait(daemon!, "SIGTERM");
    await start();
    const restarted = stripAnsi(await draw("repo-no-2"));
    expect(restarted).toContain("USERSEG");
    expect(restarted).not.toContain("a cc-candybar config for");
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
      await start();
      const asked = await render(isolated.sockPath, "repo-wt", wt);
      expect(stripAnsi(asked).replace(/\s+/g, " ")).toContain(
        `a cc-candybar config for ${project}`,
      );
      const resp = await sendClick(
        isolated.sockPath,
        answerUrl(asked, "approved"),
        ANSWER_REPLY_MS,
      );
      expect(resp.ok).toBe(true);
      await renderUntil(
        isolated.sockPath,
        "repo-wt",
        wt,
        (r) => stripAnsi(r).includes("WTSEGran"),
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
      const main = stripAnsi(await draw("repo-main"));
      expect(main).toContain("REPOSEG");
      expect(main).not.toContain("a cc-candybar config for");
    } finally {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  });
});
