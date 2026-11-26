import { windowRuntime } from "./helpers/window-runtime";
// candybar-daemon-health-ajx0.co4 — `cc-candybar install` assembles the URL
// handler app around the prebuilt Swift forwarder: the bundle on disk, the
// commands it runs and their order (sign, quit the resident instance,
// register), and what it refuses. The commands run through a fake launcher,
// so nothing here touches Launch Services.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __test__ as install,
  forwarderExecutable,
  runInstallUrlHandler,
  type InstallWorld,
} from "../src/install/index";
import type { LaunchOpts, LaunchResult } from "../src/proc/launcher";
import { URL_SCHEME } from "../src/click/wire";

describe("assembling the URL handler app", () => {
  let home: string;
  let out: string[];
  let write: typeof process.stdout.write;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "install-url-handler-"));
    out = [];
    write = process.stdout.write;
    process.stdout.write = ((s: string) => {
      out.push(s);
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = write;
    fs.rmSync(home, { recursive: true, force: true });
  });

  // A source checkout whose forwarder is built: `<root>/src` marks it, and
  // the binary sits where `just install-url-handler` leaves it.
  const checkout = (forwarder: string | null): string => {
    const root = path.join(home, "checkout");
    windowRuntime(root);
    for (const dir of ["dist/cc-extra", "src", "bin"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "dist", "index.mjs"), "// bundle\n");
    fs.writeFileSync(
      path.join(root, "dist", "cc-extra", "launcher.js"),
      "// launcher",
    );
    fs.writeFileSync(
      path.join(root, "dist", "attach-preload.cjs"),
      "// preload",
    );
    fs.writeFileSync(path.join(root, "bin", "cc-candybar"), "#!/bin/sh");
    if (forwarder !== null) {
      fs.writeFileSync(
        path.join(root, "bin", "cc-candybar-url-handler-native"),
        forwarder,
      );
    }
    return path.join(root, "dist", "index.mjs");
  };

  // A launcher that records each command and answers as told, by binary name.
  const launcher = (
    answers: Partial<Record<string, Partial<LaunchResult>>> = {},
  ) => {
    const ran: string[] = [];
    const fake: InstallWorld["launcher"] = {
      launchSync: (opts: LaunchOpts): LaunchResult => {
        if (opts.bin === "ps")
          return {
            ok: true,
            stdout: "installer started",
            stderr: "",
            exitCode: 0,
          };
        ran.push(`${path.basename(opts.bin)} ${(opts.args ?? []).join(" ")}`);
        return {
          ok: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
          ...(opts.args?.includes("--verify") ? {} : answers[path.basename(opts.bin)]),
        } as LaunchResult;
      },
    };
    return { ran, launcher: fake };
  };

  const world = (l: InstallWorld["launcher"]): InstallWorld => ({
    host: { home, env: {}, tmp: home },
    launcher: l,
  });

  const installHandler = (source: string, w: InstallWorld) =>
    runInstallUrlHandler(source, w, "darwin");

  const app = () => path.join(home, "Applications", "CCCandybarURLHandler.app");
  // What ~/Applications holds: the app, and no name an install staged or
  // kept aside.
  const applications = () => fs.readdirSync(path.dirname(app()));

  test("the app is the forwarder binary, an Info.plist claiming the scheme, signed, then the old instance quit, then registered", () => {
    const { ran, launcher: l } = launcher({
      killall: { ok: false, reason: "non-zero", exitCode: 1 },
    });
    installHandler(checkout("MACHO"), world(l));

    const exe = forwarderExecutable(app());
    expect(fs.readFileSync(exe, "utf8")).toBe("MACHO");
    expect(fs.statSync(exe).mode & 0o111).toBe(0o111);
    const plist = fs.readFileSync(
      path.join(app(), "Contents", "Info.plist"),
      "utf8",
    );
    expect(plist).toContain(`<string>${URL_SCHEME}</string>`);
    // Never activated, so a click never takes focus from the terminal.
    expect(plist).toContain("<key>LSBackgroundOnly</key>");
    expect(plist).not.toContain("<key>LSUIElement</key>");
    expect(plist).toContain("<string>com.cccandybar.url-handler</string>");
    expect(plist).toContain("<string>CCCandybarURLHandler</string>");
    // The name on the notification-authorization prompt a lost click raises.
    expect(plist).toContain(
      "<key>CFBundleDisplayName</key>\n  <string>cc-candybar</string>",
    );
    expect(ran).toEqual([
      expect.stringMatching(/^codesign --verify --strict /),
      expect.stringMatching(
        new RegExp(
          `^codesign --force --sign - ${app()}\\.\\d+\\.[0-9a-f]+\\.tmp$`,
        ),
      ),
      "killall CCCandybarURLHandler",
      `lsregister -f ${app()}`,
    ]);
    expect(applications()).toEqual(["CCCandybarURLHandler.app"]);
    expect(out.join("")).toContain("CCCandybarURLHandler was not running");
  });

  // [LAW:effects-at-boundaries] The app is assembled and signed beside its
  // place and renamed over the old one, so a sign that fails leaves the
  // handler the user had, whole.
  test("a sign that fails leaves the previous bundle whole and no staging behind", () => {
    const { launcher: l } = launcher();
    installHandler(checkout("OLD"), world(l));
    const { launcher: failing } = launcher({
      codesign: { ok: false, stderr: "no identity\n", reason: "non-zero" },
    });
    expect(() => installHandler(checkout("NEW"), world(failing))).toThrow(
      /codesign failed/,
    );
    expect(fs.readFileSync(forwarderExecutable(app()), "utf8")).toBe("OLD");
    expect(applications()).toEqual(["CCCandybarURLHandler.app"]);
  });

  // [LAW:no-ambient-temporal-coupling] Launch Services never relaunches a
  // running app, so a reinstall that left the old forwarder resident would
  // keep delivering through it until logout.
  test("a resident instance is quit before the scheme is registered, and the user is told", () => {
    const { ran, launcher: l } = launcher();
    installHandler(checkout("MACHO"), world(l));
    expect(ran.indexOf("killall CCCandybarURLHandler")).toBeLessThan(
      ran.findIndex((c) => c.startsWith("lsregister")),
    );
    expect(out.join("")).toContain("Quit the running CCCandybarURLHandler");
  });

  test("a previous bundle is replaced whole", () => {
    const stale = path.join(
      app(),
      "Contents",
      "Resources",
      "Scripts",
      "main.scpt",
    );
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "applet");
    const { launcher: l } = launcher();
    installHandler(checkout("MACHO"), world(l));
    expect(fs.existsSync(stale)).toBe(false);
    expect(applications()).toEqual(["CCCandybarURLHandler.app"]);
  });

  // [LAW:no-silent-failure] No applet is built in the forwarder's place.
  test("a checkout with no forwarder built is refused before anything is written", () => {
    const { ran, launcher: l } = launcher();
    expect(() => installHandler(checkout(null), world(l))).toThrow(
      /not built at .*bin\/cc-candybar-url-handler-native\. Run `just install-url-handler`/,
    );
    expect(fs.existsSync(path.dirname(app()))).toBe(false);
    expect(ran).toEqual([]);
  });

  test("a failed signing, or a killall that failed for any reason but no process, is loud", () => {
    const err = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(() =>
        installHandler(
          checkout("MACHO"),
          world(
            launcher({
              codesign: { ok: false, reason: "non-zero", exitCode: 1 },
            }).launcher,
          ),
        ),
      ).toThrow("codesign failed (exited with code 1)");
      expect(() =>
        installHandler(
          checkout("MACHO"),
          world(
            launcher({
              killall: { ok: false, reason: "timeout", exitCode: null },
            }).launcher,
          ),
        ),
      ).toThrow("killall CCCandybarURLHandler failed (timeout)");
    } finally {
      process.stderr.write = err;
    }
  });

  test("the Info.plist is a whole, well-formed property list", () => {
    const plist = install.infoPlist();
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(
      true,
    );
    expect(plist.trimEnd().endsWith("</plist>")).toBe(true);
    expect((plist.match(/<key>/g) ?? []).length).toBe(
      (plist.match(/<\/key>/g) ?? []).length,
    );
  });
});
