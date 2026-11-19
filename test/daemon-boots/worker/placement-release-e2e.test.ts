// [LAW:verifiable-goals] A session's state keyed to a placement — its ✚
// library, its configure key, its unsaved values — is judged against the
// config that session renders, at that session's render, and nowhere else.
// A placement its config no longer places is let go before the session draws
// (or, for the session whose own click removed it, as part of that click, so
// its undo brings the drafts back); a placement that still stands keeps its
// state whoever wrote the file that places it. Each case drives a daemon in
// this worker over a real config file, with every click a link sent over the
// wire, and reads the outcome off the bar the session draws.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { textOf, type Frame } from "../../../src/render/frame";
import {
  effectsUrl,
  VERB_APPLY_LAYOUT_OP,
  VERB_SET_STATE,
  VERB_UNDO,
} from "../../../src/click/wire";
import {
  configureMember,
  EDIT_CONFIGURE_KEY,
  EDIT_MODE_ARRANGE,
  EDIT_MODE_KEY,
} from "../../../src/config/loader/edit-mode";
import {
  EDIT_LIVE_KEY,
  insertGap,
  placementDraftKey,
} from "../../../src/config/edit-chrome";
import { menuMember } from "../../../src/config/menu-keys";
import {
  DISCLOSURE_CLOSED,
  DISCLOSURE_OPEN,
} from "../../../src/config/disclosure";
import { encodeLayoutOp } from "../../../src/config/layout-ops";
import { presetRootKey } from "../../../src/config/loader/persist-target";
import { SETTINGS } from "../../../src/config/setting-projections";
import {
  click,
  clickAnswer,
  drawnLink,
  findUrl,
  render,
  renderUntil,
  toldOf,
} from "../../helpers/daemon-e2e";
import { linkUrls } from "../../helpers/frame";
import { startDaemon, type InWorkerDaemon } from "../../helpers/in-worker-daemon";
import { prepareIsolatedDaemonEnv } from "../../helpers/spawn-isolated-daemon";
import { answerRepo } from "../../helpers/repo-approval";
import { until } from "../../helpers/until";

jest.setTimeout(60_000);

const S1 = "release-s1";
const S2 = "release-s2";

// Two segments, `a` declaring one setting, so the bar says which value `a`
// draws with: `AAA+` its default, `AAA-` the session's unsaved `false`.
const SRC = (placesA: boolean, extra = ""): string => `{
  segments: {
    a: {
      template: 'AAA{{ if .settings.x }}+{{ else }}-{{ end }}',
      settings: { x: { label: 'x', domain: 'bool', default: true } },
    },
    b: { template: 'BBB' },
  },
  ${extra}
  root: { h: [${placesA ? "'a', " : ""}'b'] },
}
`;

// What placement `id` of the default preset holds in a session: its unsaved
// `setting`, its configure key, and the ✚ library beside it.
function heldFor(id: string, setting: string) {
  const gap = insertGap("default", id, "after");
  return {
    draft: placementDraftKey("default", id, setting),
    member: configureMember("default", id),
    gap: gap.stateKey,
    gapOpen: menuMember(gap.apply),
  };
}
const A = heldFor("a", "x");

interface Case {
  daemon: InWorkerDaemon;
  readonly env: NodeJS.ProcessEnv;
  readonly project: string;
  readonly userFile: string;
  readonly projectFile: string;
}

const git = (cwd: string, ...args: string[]): void => {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
  });
};

// A daemon over a project directory — an approved repository when `repo` —
// with the user's config `config`, or none.
async function withDaemon(
  config: string | null,
  body: (c: Case) => Promise<void>,
  repo = false,
): Promise<void> {
  const { env, removeTmpDirs } = prepareIsolatedDaemonEnv("ccb-release");
  const project = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ccb-release-project-")),
  );
  if (repo) {
    git(project, "init", "-q");
    git(project, "commit", "-q", "--allow-empty", "-m", "root");
    answerRepo(project, "approved", env);
  }
  const userFile = path.join(env.XDG_CONFIG_HOME!, "cc-candybar", "config.json5");
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  if (config !== null) fs.writeFileSync(userFile, config);
  const c: Case = {
    daemon: startDaemon(env),
    env,
    project,
    userFile,
    projectFile: path.join(project, ".cc-candybar.json5"),
  };
  try {
    await body(c);
  } finally {
    await c.daemon.stop();
    removeTmpDirs();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

// One click of session writes, as the bar's own links make them.
async function setState(
  c: Case,
  sid: string,
  pairs: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  await click(
    c.daemon,
    drawnLink(
      c.daemon,
      effectsUrl(
        pairs.map(([key, value]) => ({
          verb: VERB_SET_STATE,
          args: [sid, key, value],
        })),
      ),
    ),
  );
}

// A layout edit of the default preset's root, in `layer`, as its ✖ or ✚ sends it.
async function layoutOp(
  c: Case,
  sid: string,
  op: string,
  layer = "user",
): Promise<void> {
  await click(
    c.daemon,
    drawnLink(
      c.daemon,
      effectsUrl([
        {
          verb: VERB_APPLY_LAYOUT_OP,
          args: [sid, layer, presetRootKey("default"), op],
        },
      ]),
    ),
  );
}

// Arranging, the live view on, placement `id` configured with its ✚ library
// open, and `false` unsaved for its `setting`.
const hold = (c: Case, sid: string, held = A): Promise<void> =>
  setState(c, sid, [
    [EDIT_MODE_KEY, EDIT_MODE_ARRANGE],
    [EDIT_LIVE_KEY, DISCLOSURE_OPEN],
    [EDIT_CONFIGURE_KEY, held.member],
    [held.gap, held.gapOpen],
    [held.draft, "false"],
  ]);

const writes = (frame: Frame, key: string, value?: string): boolean =>
  findUrl(linkUrls(frame), (effects) =>
    effects.some(
      (e) => e.args[1] === key && (value === undefined || e.args[2] === value),
    ),
  ) !== undefined;

// What the bar says the session holds for a placement: whether it is being
// configured (its controls are drawn, each writing its draft), whether its ✚
// library is open (the trigger writes it closed) and whether its unsaved
// `false` is drawn (the bool control offers `true` back).
function holding(frame: Frame, held = A) {
  return {
    configuring: writes(frame, held.draft),
    library: writes(frame, held.gap, DISCLOSURE_CLOSED),
    draft: writes(frame, held.draft, "true"),
  };
}
const HOLDING = { configuring: true, library: true, draft: true };
const RELEASED = { configuring: false, library: false, draft: false };

const drawsA = (f: Frame): boolean => textOf(f).includes("AAA");

// The release lines the daemon logged for `sid` in its log from line `from`.
function releasesOf(c: Case, sid: string, from = 0): string[] {
  return fs
    .readFileSync(c.daemon.log, "utf8")
    .split("\n")
    .slice(from)
    .filter(
      (l) => l.includes("placement-release:") && l.includes(`(session=${sid})`),
    );
}
const logLength = (c: Case): number =>
  fs.readFileSync(c.daemon.log, "utf8").split("\n").length;

async function releasedWith(
  c: Case,
  sid: string,
  keys: readonly string[],
  from = 0,
): Promise<void> {
  let lines: string[] = [];
  await until(
    () => (lines = releasesOf(c, sid, from)).length > 0,
    `a placement-release line for ${sid}`,
  );
  for (const key of keys) expect(lines.join("\n")).toContain(JSON.stringify(key));
}

// The placement drawn again under its id: nothing of the one before it.
async function reAddedReleased(c: Case, sid: string): Promise<void> {
  fs.writeFileSync(c.userFile, SRC(true));
  const frame = await renderUntil(c.daemon, sid, c.project, drawsA, "a placed again");
  expect(textOf(frame)).toContain("AAA+");
  expect(holding(frame)).toEqual(RELEASED);
}

describe("a session lets go of a placement's state when its config no longer places it", () => {
  test("a hand edit removing it: the next render lets go, and the id placed again opens with nothing", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      expect(holding(await render(c.daemon, S1, c.project))).toEqual(HOLDING);
      fs.writeFileSync(c.userFile, SRC(false));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap]);
      await reAddedReleased(c, S1);
    });
  });

  test("another session's click removing it: this session lets go at its own next render", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await render(c.daemon, S2, c.project);
      await layoutOp(c, S2, encodeLayoutOp({ op: "remove", target: "a" }));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap]);
      await reAddedReleased(c, S1);
    });
  });

  test("an idle session: nothing is let go at the load, only at that session's next render", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await render(c.daemon, S2, c.project);
      fs.writeFileSync(c.userFile, SRC(false));
      await renderUntil(c.daemon, S2, c.project, (f) => !drawsA(f), "a gone for s2");
      expect(releasesOf(c, S1)).toEqual([]);
      await render(c.daemon, S1, c.project);
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap]);
      await reAddedReleased(c, S1);
    });
  });

  test("a restart: an edit made while the daemon was down is judged at the session's first render", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await c.daemon.stop();
      fs.writeFileSync(c.userFile, SRC(false));
      const from = logLength(c);
      c.daemon = startDaemon(c.env);
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap], from);
      await reAddedReleased(c, S1);
    });
  });

  test("a load error cleared over the same config: the session judged under the error is judged again", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await c.daemon.stop();
      // The next daemon loads a config without `a`, then a load of it fails,
      // and only then does the session first render.
      fs.writeFileSync(c.userFile, SRC(false));
      const from = logLength(c);
      c.daemon = startDaemon(c.env);
      await renderUntil(
        c.daemon,
        S2,
        c.project,
        (f) => textOf(f).includes("BBB"),
        "the config without a",
      );
      fs.writeFileSync(c.userFile, "{ segments: ");
      await renderUntil(
        c.daemon,
        S2,
        c.project,
        (f) => textOf(f).includes("⚠"),
        "the load error",
      );
      await render(c.daemon, S1, c.project);
      expect(releasesOf(c, S1, from)).toEqual([]);
      // The same config again: the state it built is kept, and the error goes.
      fs.writeFileSync(c.userFile, SRC(false));
      await renderUntil(
        c.daemon,
        S1,
        c.project,
        (f) => !textOf(f).includes("⚠"),
        "the config without a, again",
      );
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap], from);
      await reAddedReleased(c, S1);
    });
  });

  test("id reuse: a removed segment added back after the session drew without it opens with its library closed and no drafts", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await layoutOp(c, S1, encodeLayoutOp({ op: "remove", target: "a" }));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await releasedWith(c, S1, [A.draft, EDIT_CONFIGURE_KEY, A.gap]);
      // `+` after `b` mints `a` again: the id is free.
      await layoutOp(
        c,
        S1,
        encodeLayoutOp({
          op: "insert",
          segment: "a",
          anchor: "b",
          relation: "after",
        }),
      );
      const frame = await renderUntil(c.daemon, S1, c.project, drawsA, "a again");
      expect(textOf(frame)).toContain("AAA+");
      expect(holding(frame)).toEqual(RELEASED);
    });
  });

  test("one click that writes a placement's draft and removes it lets go of the draft it wrote", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await click(
        c.daemon,
        drawnLink(
          c.daemon,
          effectsUrl([
            { verb: VERB_SET_STATE, args: [S1, A.draft, "false"] },
            {
              verb: VERB_APPLY_LAYOUT_OP,
              args: [
                S1,
                "user",
                presetRootKey("default"),
                encodeLayoutOp({ op: "remove", target: "a" }),
              ],
            },
          ]),
        ),
      );
      // Let go in the click itself, before any render of the session.
      await releasedWith(c, S1, [A.draft]);
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await reAddedReleased(c, S1);
    });
  });

  test("the clicker's undo of its removal brings its drafts back", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await layoutOp(c, S1, encodeLayoutOp({ op: "remove", target: "a" }));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      await releasedWith(c, S1, [A.draft]);
      await click(
        c.daemon,
        drawnLink(c.daemon, effectsUrl([{ verb: VERB_UNDO, args: [S1] }])),
      );
      const frame = await renderUntil(c.daemon, S1, c.project, drawsA, "a back");
      expect(textOf(frame)).toContain("AAA-");
    });
  });

  // Why a click that loaded nothing judges nothing: the config it lands on
  // gates every write, so no link drawn before a removal still writes a key
  // the removed placement held.
  test("a link from a frame drawn before the removal is refused, writing nothing the id placed again inherits", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await setState(c, S1, [
        [EDIT_MODE_KEY, EDIT_MODE_ARRANGE],
        [EDIT_LIVE_KEY, DISCLOSURE_OPEN],
      ]);
      fs.writeFileSync(c.userFile, SRC(false));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a gone");
      for (const [key, value] of [
        [EDIT_CONFIGURE_KEY, A.member],
        [A.gap, A.gapOpen],
        [A.draft, "false"],
      ] as const) {
        const answer = await clickAnswer(
          c.daemon,
          drawnLink(
            c.daemon,
            effectsUrl([{ verb: VERB_SET_STATE, args: [S1, key, value] }]),
          ),
        );
        expect([key, toldOf(answer)]).toEqual([key, "BAD_REQUEST"]);
      }
      await reAddedReleased(c, S1);
      expect(releasesOf(c, S1)).toEqual([]);
    });
  });
});

describe("a placement that still stands keeps its state", () => {
  test("a config that fails to load releases nothing, though the bar it draws places nothing of the file's", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      await c.daemon.stop();
      // Broken at the restart: the bar draws the bundled default, which
      // places no `a`.
      fs.writeFileSync(c.userFile, "{ segments: ");
      const from = logLength(c);
      c.daemon = startDaemon(c.env);
      const broken = await render(c.daemon, S1, c.project);
      expect(drawsA(broken)).toBe(false);
      fs.writeFileSync(c.userFile, SRC(true));
      const frame = await renderUntil(c.daemon, S1, c.project, drawsA, "a again");
      expect(textOf(frame)).toContain("AAA-");
      expect(holding(frame)).toEqual(HOLDING);
      expect(releasesOf(c, S1, from)).toEqual([]);
    });
  });

  test("a load that drops a placement naming an undeclared segment releases nothing, and the fix finds it intact", async () => {
    await withDaemon(SRC(true), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      // `a` still placed, its declaration misspelt: the load draws the bar
      // without it and says why.
      fs.writeFileSync(c.userFile, SRC(true).replace("    a: {", "    aa: {"));
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsA(f), "a dropped");
      await render(c.daemon, S1, c.project);
      fs.writeFileSync(c.userFile, SRC(true));
      const frame = await renderUntil(c.daemon, S1, c.project, drawsA, "a fixed");
      expect(textOf(frame)).toContain("AAA-");
      expect(holding(frame)).toEqual(HOLDING);
      expect(releasesOf(c, S1)).toEqual([]);
    });
  });

  test("a plugin whose folder is missing for one load: its placement's state is intact when it returns", async () => {
    const seg = "plugins.deploy.status";
    const P = heldFor(seg, "c");
    const src = `{ plugins: ['./deploy/plugin.json5'], root: { h: ['${seg}', 'b'] }, segments: { b: { template: 'BBB' } } }\n`;
    await withDaemon(src, async (c) => {
      const folder = path.join(path.dirname(c.userFile), "deploy");
      const away = `${folder}.away`;
      fs.mkdirSync(folder);
      fs.writeFileSync(
        path.join(folder, "plugin.json5"),
        `{ segments: { status: { template: 'DEP{{ if .settings.c }}+{{ else }}-{{ end }}', settings: { c: { label: 'c', domain: 'bool', default: true } } } } }\n`,
      );
      const drawsDep = (f: Frame): boolean => textOf(f).includes("DEP");
      await renderUntil(c.daemon, S1, c.project, drawsDep, "the plugin's cell");
      await hold(c, S1, P);
      expect(holding(await render(c.daemon, S1, c.project), P)).toEqual(HOLDING);
      fs.renameSync(folder, away);
      await renderUntil(c.daemon, S1, c.project, (f) => !drawsDep(f), "the plugin gone");
      await render(c.daemon, S1, c.project);
      fs.renameSync(away, folder);
      const frame = await renderUntil(c.daemon, S1, c.project, drawsDep, "the plugin back");
      expect(textOf(frame)).toContain("DEP-");
      expect(holding(frame, P)).toEqual(HOLDING);
      expect(releasesOf(c, S1)).toEqual([]);
    });
  });

  test("a layer file appearing", async () => {
    await withDaemon(
      SRC(true),
      async (c) => {
        await render(c.daemon, S1, c.project);
        await hold(c, S1);
        fs.writeFileSync(c.projectFile, `{ segments: { b: { template: 'CCC' } } }\n`);
        const frame = await renderUntil(
          c.daemon,
          S1,
          c.project,
          (f) => textOf(f).includes("CCC"),
          "the project's layer",
        );
        expect(textOf(frame)).toContain("AAA-");
        expect(holding(frame)).toEqual(HOLDING);
        expect(releasesOf(c, S1)).toEqual([]);
      },
      true,
    );
  });

  test("the first config file being created", async () => {
    // The bundled default's own placement, under no file at all.
    const G = heldFor("gitaculous", "sha");
    await withDaemon(null, async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1, G);
      expect(holding(await render(c.daemon, S1, c.project), G)).toEqual(HOLDING);
      fs.writeFileSync(c.userFile, `{ globals: { padding: 2 } }\n`);
      await until(
        () =>
          fs
            .readFileSync(c.daemon.log, "utf8")
            .split("\n")
            .some((l) => l.includes("config loaded") && l.includes(c.userFile)),
        "the user's file loaded",
      );
      expect(holding(await render(c.daemon, S1, c.project), G)).toEqual(HOLDING);
      expect(releasesOf(c, S1)).toEqual([]);
    });
  });

  test("an edit that copies a row into the file it writes", async () => {
    await withDaemon(
      SRC(true),
      async (c) => {
        await render(c.daemon, S1, c.project);
        await hold(c, S1);
        // Removing `b` in the project's layer copies the user's row there.
        await layoutOp(
          c,
          S1,
          encodeLayoutOp({ op: "remove", target: "b" }),
          "project",
        );
        const frame = await renderUntil(
          c.daemon,
          S1,
          c.project,
          (f) => !textOf(f).includes("BBB"),
          "b gone",
        );
        expect(fs.readFileSync(c.projectFile, "utf8")).toContain('"a"');
        expect(textOf(frame)).toContain("AAA-");
        expect(holding(frame)).toEqual(HOLDING);
        expect(releasesOf(c, S1)).toEqual([]);
      },
      true,
    );
  });

  test("a placement that only an insert entry places", async () => {
    await withDaemon(
      SRC(true),
      async (c) => {
        await render(c.daemon, S1, c.project);
        await hold(c, S1);
        // While the session is idle, the repository's layer takes `a` over:
        // the user's row drops it and an insert entry places it.
        fs.writeFileSync(
          c.projectFile,
          `{ insert: [{ seg: 'a', after: 'b' }] }\n`,
        );
        fs.writeFileSync(c.userFile, SRC(false));
        await renderUntil(
          c.daemon,
          S2,
          c.project,
          (f) => textOf(f).indexOf("AAA") > textOf(f).indexOf("BBB"),
          "a placed by the insert",
        );
        await render(c.daemon, S1, c.project);
        expect(releasesOf(c, S1)).toEqual([]);
        // Back in the user's row, it draws what the session left unsaved.
        fs.writeFileSync(c.projectFile, `{}\n`);
        fs.writeFileSync(c.userFile, SRC(true));
        const frame = await renderUntil(
          c.daemon,
          S1,
          c.project,
          (f) => textOf(f).includes("AAA-"),
          "a back in the user's row",
        );
        expect(holding(frame)).toEqual(HOLDING);
      },
      true,
    );
  });

  test("a switch between presets of one config", async () => {
    const presets = `presets: { other: { root: { h: ['b', 'a'] } } },`;
    await withDaemon(SRC(true, presets), async (c) => {
      await render(c.daemon, S1, c.project);
      await hold(c, S1);
      const preset = SETTINGS.preset.sessionKey;
      await setState(c, S1, [[preset, "other"]]);
      // `a` in `other` is a placement of its own, with nothing unsaved.
      expect(textOf(await render(c.daemon, S1, c.project))).toContain("AAA+");
      await setState(c, S1, [[preset, "default"]]);
      const frame = await render(c.daemon, S1, c.project);
      expect(textOf(frame)).toContain("AAA-");
      expect(holding(frame)).toEqual(HOLDING);
      expect(releasesOf(c, S1)).toEqual([]);
    });
  });
});
