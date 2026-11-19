import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CHECKOUT_FRESH_MS } from "../../../src/daemon/checkout-observations";
import { textOf } from "../../../src/render/frame";
import { checkoutFiles, type CheckoutFiles } from "../../../src/utils/git-root";
import {
  configFlag,
  frameRequest,
  hookData,
  renderBody,
} from "../../helpers/daemon-e2e";
import { heldClock } from "../../helpers/held-clock";
import {
  startDaemon,
  type InWorkerDaemon,
} from "../../helpers/in-worker-daemon";
import { answerRepo } from "../../helpers/repo-approval";
import {
  prepareIsolatedDaemonEnv,
  type IsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "pipe", timeout: 5_000 });
};

let root: string;
let isolated: IsolatedDaemonEnv;
let daemon: InWorkerDaemon | undefined;
let config: string;
let clock: ReturnType<typeof heldClock>;

beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-checkout-")),
  );
  isolated = prepareIsolatedDaemonEnv("ccb-checkout");
  clock = heldClock(new Date());
  config = path.join(root, "bar.json5");
  fs.writeFileSync(
    config,
    JSON.stringify({
      segments: {
        location: {
          template:
            "{{ if .location.noRepo }}no repo{{ else }}{{ .location.main }}|{{ .location.worktree }}|{{ .location.subpath }}{{ end }}",
        },
      },
      root: { h: ["location"] },
    }),
  );
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  isolated.removeTmpDirs();
  fs.rmSync(root, { recursive: true, force: true });
});

function directory(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function linkedCheckout() {
  const main = directory("main");
  const linked = path.join(root, "linked");
  git(main, "init", "-q", "-b", "main");
  git(
    main,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  );
  git(main, "worktree", "add", "-q", linked);
  return { main, linked };
}

function start(files: CheckoutFiles = checkoutFiles): InWorkerDaemon {
  daemon = startDaemon(isolated.env, { clock, checkoutFiles: files });
  return daemon;
}

// Give the workspace and the client's cwd different values so the case also
// detects sourcing display location from the config origin by mistake.
async function label(
  running: InWorkerDaemon,
  session: string,
  current: string,
  cwd = root,
): Promise<string> {
  const hook = hookData(session, cwd);
  return textOf(
    await frameRequest(running, {
      ...renderBody(session, cwd, { termCols: 300 }, [
        "cc-candybar",
        "--config-only",
        config,
      ]),
      hookData: {
        ...hook,
        workspace: { ...hook.workspace, current_dir: current },
      },
    }),
  );
}

// [LAW:behavior-not-structure] Count actual filesystem observations at the
// daemon's adapter while real requests select their own workspace paths.
test("session requests share Git metadata by physical workspace, including aliases", async () => {
  const { main, linked } = linkedCheckout();
  const inside = directory("linked/sub/leaf");
  const alias = path.join(root, "alias");
  fs.symlinkSync(inside, alias);
  const stats: string[] = [];
  const realpaths: string[] = [];
  const metadata: string[] = [];
  const running = start({
    ...checkoutFiles,
    stat(file) {
      stats.push(file);
      return checkoutFiles.stat(file);
    },
    realpath(file) {
      realpaths.push(file);
      return checkoutFiles.realpath(file);
    },
    text(file) {
      metadata.push(file);
      return checkoutFiles.text(file);
    },
  });

  expect(await label(running, "first", inside)).toContain(
    `${main}|linked|/sub/leaf`,
  );
  const dotGit = path.join(linked, ".git");
  expect(stats.filter((file) => file === dotGit)).toHaveLength(1);
  expect(metadata.map((file) => path.basename(file))).toEqual([
    ".git",
    "commondir",
    "gitdir",
  ]);
  const coldStats = [...stats];
  const coldRealpaths = [...realpaths];

  expect(await label(running, "next", inside)).toContain(
    `${main}|linked|/sub/leaf`,
  );
  expect(await label(running, "alias", alias)).toContain(
    `${main}|linked|/sub/leaf`,
  );
  expect(stats).toEqual(coldStats);
  expect(realpaths).toEqual([...coldRealpaths, alias]);
  expect(metadata).toHaveLength(3);

  const other = directory("other");
  git(other, "init", "-q");
  expect(await label(running, "next", other)).toContain(`${other}||`);
  fs.unlinkSync(alias);
  fs.symlinkSync(other, alias);
  await clock.settle(CHECKOUT_FRESH_MS);
  expect(await label(running, "alias", alias)).toContain(`${other}||`);
});

test("an existing session sees git init after a cached absence expires", async () => {
  const plain = directory("plain");
  const running = start();
  expect(await label(running, "plain", plain)).toContain("no repo");
  git(plain, "init", "-q");
  await clock.settle(CHECKOUT_FRESH_MS);
  expect(await label(running, "plain", plain)).toContain(`${plain}||`);
});

// [LAW:parse-dont-validate] A checkout shown as linked a moment ago gives
// no permission to load a config after the checkout stopped being linked.
test("fresh config proof cannot borrow a cached worktree's repository approval", async () => {
  const { main, linked } = linkedCheckout();
  answerRepo(main, "approved", isolated.env);
  fs.writeFileSync(
    path.join(linked, ".cc-candybar.json5"),
    JSON.stringify({
      segments: { repo: { template: "APPROVED PROJECT" } },
      root: { h: ["repo"] },
    }),
  );
  const running = start();
  const draw = async () =>
    textOf(
      await frameRequest(
        running,
        renderBody("project", linked, { termCols: 300 }, configFlag(config)),
      ),
    );
  expect(await draw()).toContain("APPROVED PROJECT");

  fs.unlinkSync(path.join(linked, ".git"));
  // A separate Git directory keeps `.git` a file. Reading its stat again
  // cannot distinguish the new proof from the one previously held.
  git(linked, "init", "-q", "--separate-git-dir", path.join(root, "new-git"));
  running.daemon.rediscover();
  const result = await draw();
  expect(result).toContain(`${linked}||`);
  expect(result).not.toContain("APPROVED PROJECT");
});
