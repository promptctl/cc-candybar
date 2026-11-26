// Two Node processes contend for the same user's install. SIGKILL prevents
// the first one's finally block from running, as a crashed installer would.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processWorld } from "../../../src/host";
import { withInstallClaim } from "../../../src/install/claim";

test("a live install excludes a second process, and its exit releases the claim", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-claim-"));
  const held = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       import {processWorld} from "./src/host.ts";
       import {withInstallClaim} from "./src/install/claim.ts";
       withInstallClaim(process.argv[1], processWorld().launcher, () => {
         fs.writeSync(1, "holding");
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
       });`,
      dir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(held, "close");
  const stderr: Buffer[] = [];
  held.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  try {
    const ready = await Promise.race([
      once(held.stdout, "data").then(([chunk]) => String(chunk)),
      exited.then(([code]) => {
        throw new Error(`holder exited ${code}: ${Buffer.concat(stderr)}`);
      }),
    ]);
    expect(ready).toBe("holding");
    const retry = () =>
      withInstallClaim(dir, processWorld().launcher, () => "installed");
    expect(retry).toThrow(/Another install holds/);
    held.kill("SIGKILL");
    await exited;
    expect(retry()).toBe("installed");
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    held.kill("SIGKILL");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// The child uses the public installer in a real temporary home. Only the
// platform commands are simulated; publication, settings reads, replacement
// directories, journal writes and SIGKILL all go through the OS.
test.each([
  ["old directory moved aside", "custom command"],
  ["registration", "custom command"],
  ["registration then external edit", "another program"],
  ["committed", "staged"],
])("a retry reconciles an installer killed at %s", (when, expected) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "install-retry-"));
  const home = path.join(root, "home");
  const checkout = path.join(root, "checkout");
  const entry = path.join(checkout, "dist", "index.mjs");
  const settings = path.join(home, ".claude", "settings.json");
  const child = `
    import fs from "node:fs";
    import path from "node:path";
    import { install } from "./src/install/index.ts";
    import { processWorld } from "./src/host.ts";
    const [home,entry,when,force]=process.argv.slice(1);
    const die = () => process.kill(process.pid,"SIGKILL");
    const rename = fs.renameSync;
    fs.renameSync = (source,dest) => {
      rename(source,dest);
      if(when==="old directory moved aside" && path.basename(source)==="cc-extra" && dest.endsWith(".tmp")) die();
    };
    const append = fs.appendFileSync;
    fs.appendFileSync = (file,bytes,...rest) => {
      append(file,bytes,...rest);
      if(when==="committed" && JSON.parse(bytes).op==="commit") die();
    };
    const real = processWorld();
    install(force === "force"? ["--force"]:[],entry,{
      host:{home,tmp:home,env:{}},
      launcher:{launchSync(opts){
        if(opts.bin==="ps") return real.launcher.launchSync(opts);
        if(when.startsWith("registration") && opts.category==="install.lsregister") die();
        return {ok:true,exitCode:0,stdout:"",stderr:""};
      }}
    },"darwin");
  `;
  const invoke = (stop: string, force = "") =>
    spawnSync(
      process.execPath,
      [
        "--require",
        "./scripts/lib/version-stamp.cjs",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        child,
        home,
        entry,
        stop,
        force,
      ],
      { encoding: "utf8" },
    );
  try {
    for (const dir of ["src", "dist/cc-extra", "bin"])
      fs.mkdirSync(path.join(checkout, dir), { recursive: true });
    fs.mkdirSync(home);
    for (const [file, bytes] of Object.entries({
      "dist/index.mjs": "// initial release",
      "dist/cc-extra/launcher.js": "// launcher",
      "dist/attach-preload.cjs": "// preload",
      "bin/cc-candybar": "#!/bin/sh",
      "bin/cc-candybar-url-handler-native": "forwarder",
    }))
      fs.writeFileSync(path.join(checkout, file), bytes);
    expect(invoke("initial").status).toBe(0);
    fs.writeFileSync(
      settings,
      JSON.stringify({
        statusLine: { type: "command", command: "custom command" },
      }),
    );
    fs.writeFileSync(entry, "// replacement release");
    expect(invoke(when, "force").signal).toBe("SIGKILL");
    const externallyEdited = when === "registration then external edit";
    if (externallyEdited)
      fs.writeFileSync(
        settings,
        JSON.stringify({ statusLine: { type: "command", command: expected } }),
      );
    const retried = invoke("retry");
    expect({ status: retried.status, error: retried.error?.message }).toEqual({
      status: 0,
      error: undefined,
    });
    expect(retried.stderr).toContain("recovered interrupted installation");
    const actual = JSON.parse(fs.readFileSync(settings, "utf8")).statusLine
      .command;
    if (expected === "staged")
      expect(actual).toContain("CCCandybar/bin/cc-candybar");
    else expect(actual).toBe(expected);
    const staged = path.join(
      home,
      "Library/Application Support/CCCandybar",
      "dist",
    );
    expect(fs.readFileSync(path.join(staged, "index.mjs"), "utf8")).toBe(
      "// replacement release",
    );
    expect(
      fs.readFileSync(path.join(staged, "cc-extra", "launcher.js"), "utf8"),
    ).toBe("// launcher");
    const entries = fs.readdirSync(home, { recursive: true, encoding: "utf8" });
    const leftovers = entries.filter((name) =>
      /\.tmp$|\.cc-candybar-install/.test(name),
    );
    if (externallyEdited) {
      expect(leftovers).toHaveLength(1);
      const backup = path.join(home, leftovers[0]!);
      expect(retried.stderr).toContain(`previous contents kept at ${backup}`);
      expect(
        JSON.parse(fs.readFileSync(backup, "utf8")).statusLine.command,
      ).toBe("custom command");
    } else expect(leftovers).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
