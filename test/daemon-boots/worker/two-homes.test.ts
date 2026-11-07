// [LAW:verifiable-goals] The home lane's acceptance test: two renderers under
// two named homes, sharing one runtime directory, each serving its own socket,
// given the same config text. Each draws one bar and takes one durable write,
// one naming its config file and one finding it, and no file under either
// root names either root, so neither leaves a trace of the other and a tree
// copied under a third root is a renderer of its own: its undo writes its own
// config. The homes are named through a symlink and the config file through
// the directory it points at, as a client whose cwd is a realpath names it, so
// a root has two spellings and a file in it is the home's under either. And the
// links lane's: a link B draws names B, the URL handler's socket rule takes it
// to B's socket and no other, and A, handed it anyway, refuses it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  HOME_CONFIG_DIR,
  HOME_ENV,
  MAIN_NAME,
  NAME_ENV,
  RUNTIME_DIR_ENV,
  homeOf,
  socketFile,
  type RendererHome,
} from "../../../src/daemon/home";
import { logPath, socketPath } from "../../../src/daemon/paths";
import { logLines } from "../../../src/daemon/log";
import {
  PROTOCOL_VERSION,
  URL_FRAME_KIND,
  URL_FRAME_VERSION,
  encodeFrame,
} from "../../../src/daemon/protocol";
import { VERB_UNDO, effectsUrl, parseHandlerUrl } from "../../../src/click/wire";
import { isBarLink } from "../../../src/click/scheme";
import { handleConnection } from "../../../src/daemon/connection";
import type { DaemonLog } from "../../../src/daemon/log";
import type { Daemon } from "../../../src/daemon/daemon";
import { textOf } from "../../../src/render/frame";
import { linkUrls } from "../../helpers/frame";
import { effectsOf } from "../../helpers/click";
import { click, configFlag, render } from "../../helpers/daemon-e2e";
import { homeEndpoint, sendDaemonRequest, type DaemonEndpoint } from "../../helpers/daemon-wire";
import { fakeDialer } from "../../helpers/dial";
import { until } from "../../helpers/until";
import { hostOf } from "../../helpers/host";
import { buildDaemon } from "../../helpers/in-worker-daemon";
import { NO_TMUX_AT_EXIT } from "../../helpers/worker-edges";

jest.setTimeout(30_000);

// A `persist` click writes the field into the home's config file, which is the
// durable write a renderer makes on its own behalf. A `set` click writes the
// session's state, which the bar draws as `mark=…`, so a render says which
// renderer a click landed on.
const CONFIG = `{
  variables: { mark: { kind: "state", key: "mark", default: "unset" } },
  actions: {
    pad: { persist: "padding", to: "4" },
    mark: { set: "mark", to: "set" },
  },
  segments: {
    pad: { template: '{{ action "pad" "[pad]" }}', bg: "surface", fg: "foreground" },
    mark: { template: '{{ action "mark" "[mark]" }} mark={{ .mark }}' },
  },
  root: { h: ["pad", "mark"] },
}
`;

interface Renderer {
  readonly home: RendererHome;
  readonly daemon: Daemon;
  readonly daemonLog: DaemonLog;
  // The renderer as a test reaches it: through the dialer both listen on.
  readonly target: DaemonEndpoint;
  readonly stopListening: () => void;
}

// Every file under `root` but the log, read whole. The log is the renderer's
// diagnostic output: it names the paths it acted on by design, and nothing
// reads it back, so it cannot carry a home's root into a renderer's work.
function storedUnder(root: string): Array<{ file: string; text: string }> {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((file) => path.relative(root, file) !== path.join("state", "daemon.log"))
    .map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}


test("two renderers under two homes leave no trace of each other or of their own roots, and a copied home undoes into its own config", async () => {
  // One short temporary root for every home and the runtime directory they
  // share, so the socket paths stay under the platform's limit. The homes sit
  // under `linked`, a symlink to the root's real directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccb-2h-"));
  const real = fs.realpathSync.native(root);
  const linked = path.join(root, "l");
  fs.symlinkSync(real, linked);
  const runtime = path.join(root, "run");
  fs.mkdirSync(runtime, { mode: 0o700 });
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir);

  const homeNamed = (name: string): RendererHome =>
    homeOf(
      hostOf({
        ...process.env,
        [HOME_ENV]: path.join(linked, name),
        [NAME_ENV]: name,
        [RUNTIME_DIR_ENV]: runtime,
      }),
    );
  // Every spelling of a home's root: through the link, the temporary
  // directory as the platform names it, and the directory on disk.
  const spellingsOf = (home: RendererHome): string[] =>
    [linked, root, real].map((r) => path.join(r, home.name));
  const treeOf = (home: RendererHome): string => path.join(real, home.name);
  const configOf = (home: RendererHome): string =>
    path.join(treeOf(home), HOME_CONFIG_DIR, "config.json5");
  const running: Renderer[] = [];
  const dialer = fakeDialer();
  const start = async (home: RendererHome): Promise<Renderer> => {
    const { daemon, daemonLog } = buildDaemon({ home });
    const stopListening = dialer.listen(socketPath(home), (sock) =>
      handleConnection(daemon, sock),
    );
    const r = { home, daemon, daemonLog, target: homeEndpoint(home, dialer), stopListening };
    running.push(r);
    return r;
  };
  // Closing lands every debounced write, so the tree holds all it will.
  const stop = async (r: Renderer): Promise<void> => {
    running.splice(running.indexOf(r), 1);
    await r.daemon.close(NO_TMUX_AT_EXIT);
    r.stopListening();
    await r.daemonLog.drained();
    r.daemonLog.dispose();
  };

  try {
    const homes = [homeNamed("alpha"), homeNamed("beta")] as const;
    for (const home of homes) {
      fs.mkdirSync(path.dirname(configOf(home)), { recursive: true });
      fs.writeFileSync(configOf(home), CONFIG);
    }
    const [a, b] = [await start(homes[0]), await start(homes[1])];
    expect(socketPath(a.home)).toBe(path.join(runtime, "alpha.sock"));
    expect(socketPath(b.home)).toBe(path.join(runtime, "beta.sock"));

    // Alpha names its config file on disk, so its origin holds a file in its
    // home under the root's other spelling; beta's is found by the search.
    const sidOf = (r: Renderer): string => `two-homes-${r.home.name}`;
    for (const [r, args] of [
      [a, configFlag(configOf(a.home))],
      [b, []],
    ] as const) {
      const bar = await render(r.target, sidOf(r), projectDir, {}, [...args]);
      expect(textOf(bar)).toContain("[pad]");
      const url = linkUrls(bar).find((u) =>
        effectsOf(u).some((e) => e.verb === "persist" || e.verb === "set-config"),
      );
      if (url === undefined) throw new Error(`no persist link in:\n${textOf(bar)}`);
      await click(r.target, url);
      expect(fs.readFileSync(configOf(r.home), "utf8")).toMatch(/padding:\s*4/);
    }
    // Every link B's bar draws names B: the bar closed, and with its settings
    // menu open, which draws its pickers, steppers and closes.
    const linksSid = "two-homes-links";
    const closedBar = await render(b.target, linksSid, projectDir);
    const door = linkUrls(closedBar).find((u) =>
      effectsOf(u).some((e) => e.verb === "set-state" && e.args.includes("candybar.menu")),
    );
    if (door === undefined) throw new Error(`no settings door in:\n${textOf(closedBar)}`);
    await click(b.target, door);
    const drawn = [...linkUrls(closedBar), ...linkUrls(await render(b.target, linksSid, projectDir))].filter(isBarLink);
    expect(drawn.length).toBeGreaterThan(linkUrls(closedBar).length);
    const misnamed = drawn.filter((u) => {
      const parsed = parseHandlerUrl(u);
      return !parsed.ok || parsed.to !== b.home.name;
    });
    expect(misnamed).toEqual([]);

    // A link names the renderer that drew it, and reaches that renderer and
    // no other.
    const sid = "two-homes-mark";
    const markOf = async (r: Renderer): Promise<string> =>
      /mark=(\w+)/.exec(textOf(await render(r.target, sid, projectDir)))?.[1] ?? "";
    const clickEvents = (r: Renderer): string[] =>
      logLines(logPath(r.home)).filter((l) => / click queued=/.test(l));
    // One link as the URL handler hands it over: one url frame, no answer
    // read, so the click's event is where it is seen.
    const forward = async (sock: string, url: string, r: Renderer): Promise<string> => {
      const before = clickEvents(r).length;
      const dialed = await dialer.dial(sock).settled;
      if (!dialed.ok) throw new Error(dialed.failure.message);
      dialed.conn.end(encodeFrame({ kind: URL_FRAME_KIND, urlV: URL_FRAME_VERSION, url }));
      await until(() => clickEvents(r).length > before, `${r.home.name}'s event for the forwarded link`);
      return clickEvents(r).at(-1)!;
    };
    expect(await markOf(a)).toBe("unset");
    const marked = linkUrls(await render(b.target, sid, projectDir)).find((u) =>
      effectsOf(u).some((e) => e.verb === "set-state" && e.args.includes("mark")),
    );
    if (marked === undefined) throw new Error("no mark link in beta's bar");
    const link = parseHandlerUrl(marked);
    if (!link.ok) throw new Error(link.problem);
    expect(link.to).toBe(b.home.name);
    // The URL handler's socket rule (url-handler/address.swift): the file the
    // name selects in the per-uid directory, main's for a link naming none.
    const chosen = path.join(runtime, socketFile(link.to ?? MAIN_NAME));
    expect(chosen).toBe(socketPath(b.home));
    const landed = await forward(chosen, marked, b);
    expect(landed).toContain(` to=${b.home.name} `);
    expect(landed).toContain(" outcome=ok");
    expect(await markOf(b)).toBe("set");
    expect(await markOf(a)).toBe("unset");

    // Handed to A anyway, by the URL handler's frame or url-handle's request,
    // B's link is refused, its event says whose it was, and A is untouched.
    const misdelivered = await forward(socketPath(a.home), marked, a);
    expect(misdelivered).toContain(` to=${b.home.name} `);
    expect(misdelivered).toContain(" outcome=bad-request");
    const refusedBefore = clickEvents(a).length;
    const relayed = await sendDaemonRequest(a.target, { v: PROTOCOL_VERSION, kind: "click", url: marked });
    expect(relayed).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(relayed.ok ? "" : relayed.error).toContain(`addressed to renderer "${b.home.name}"`);
    await until(() => clickEvents(a).length > refusedBefore, "alpha's event for the relayed link");
    expect(clickEvents(a).at(-1)).toContain(` via=cli to=${b.home.name} `);
    expect(await markOf(a)).toBe("unset");

    // A link that names no renderer runs nowhere: the renderer it reached
    // refuses it, naming its form.
    const unnamed = await sendDaemonRequest(a.target, { v: PROTOCOL_VERSION, kind: "click", url: `cc-candybar://set-state/${sid}/mark/set` });
    expect(unnamed).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(unnamed.ok ? "" : unnamed.error).toContain("the direct verb form");
    expect(await markOf(a)).toBe("unset");

    await stop(a);
    await stop(b);

    // No stored file names a root, the other's or its own.
    for (const home of homes) {
      const files = storedUnder(treeOf(home));
      expect(files.map((f) => path.relative(treeOf(home), f.file))).toEqual(
        expect.arrayContaining([
          path.join("state", "session-state.json"),
          path.join("state", "settings-history.json"),
        ]),
      );
      const naming = files.filter((f) =>
        homes.some((h) => spellingsOf(h).some((r) => f.text.includes(r))),
      );
      expect(naming.map((f) => f.file)).toEqual([]);
    }
    expect(fs.readFileSync(configOf(a.home), "utf8")).toBe(
      fs.readFileSync(configOf(b.home), "utf8"),
    );

    // Alpha's tree, copied under a third root, is a renderer of its own: an
    // undo of alpha's session there rewrites the copy's config, and alpha's
    // stays as it was.
    const alphaText = fs.readFileSync(configOf(a.home), "utf8");
    const gammaHome = homeNamed("gamma");
    fs.cpSync(treeOf(a.home), treeOf(gammaHome), { recursive: true });
    const c = await start(gammaHome);
    await click(c.target, effectsUrl(c.home.name, [{ verb: VERB_UNDO, args: [sidOf(a)] }]));
    expect(fs.readFileSync(configOf(c.home), "utf8")).toBe(CONFIG);
    expect(fs.readFileSync(configOf(a.home), "utf8")).toBe(alphaText);
  } finally {
    for (const r of [...running]) await stop(r);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
