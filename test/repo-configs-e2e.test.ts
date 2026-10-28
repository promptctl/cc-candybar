// [LAW:verifiable-goals] A cloned repository's cc-candybar config runs only
// once the user approves it, by one click in the bar, and the answer holds:
// across a daemon restart and across edits of the file, as Claude Code's
// answer for a project's MCP servers does. Measured the way it would be
// exploited: a REAL daemon over a REAL socket, a project config whose
// `shell` variable leaves a marker on disk when it runs.

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
import { repoConfigsPath } from "../src/daemon/repo-configs";
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
    expect(text).toContain(`${project} has a cc-candybar config`);
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
    expect(stripAnsi(approved)).not.toContain("has a cc-candybar config");
    expect(fs.existsSync(marker)).toBe(true);

    // A restart reads the answer back from the state directory.
    await killAndWait(daemon!, "SIGTERM");
    await start();
    const restarted = stripAnsi(await draw("repo-yes-2"));
    expect(restarted).toContain("REPOSEG");
    expect(restarted).not.toContain("has a cc-candybar config");

    // An edit reloads into the edited config, and never asks again.
    fs.writeFileSync(projectFile, repoConfig(marker, "EDITED"));
    const edited = await renderUntil(
      isolated.sockPath,
      "repo-yes-2",
      project,
      (r) => stripAnsi(r).includes("EDITED"),
      "the edited config",
    );
    expect(stripAnsi(edited)).not.toContain("has a cc-candybar config");
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
      (r) => !stripAnsi(r).includes("has a cc-candybar config"),
      "the bar without the question",
    );
    expect(stripAnsi(declined)).toContain("USERSEG");
    expect(stripAnsi(declined)).not.toContain("REPOSEG");

    await killAndWait(daemon!, "SIGTERM");
    await start();
    const restarted = stripAnsi(await draw("repo-no-2"));
    expect(restarted).toContain("USERSEG");
    expect(restarted).not.toContain("has a cc-candybar config");
    expect(fs.existsSync(marker)).toBe(false);
  });
});
