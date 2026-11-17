// [LAW:one-source-of-truth] The host's config discovery: one discovery and one
// watch per origin the live sessions name, a snapshot handed on only when
// what it found moved, and a click's config found at the origin its session
// last drew from.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RenderOrigin } from "../src/config-hint";
import type { ConfigSnapshot } from "../src/config/config-snapshot";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { ConfigDiscovery } from "../src/daemon/config-discovery/config-discovery";
import { sessionIdOf, type SessionId } from "../src/daemon/foundations/session-id";
import { locations, stateDir } from "../src/daemon/paths";
import { systemTimekeeper } from "../src/time";
import { HOST, hostOf } from "./helpers/host";
import { until } from "./helpers/until";

const S1 = sessionIdOf("s1");
const S2 = sessionIdOf("s2");
const S3 = sessionIdOf("s3");

let dir: string;
let file: string;
let origin: RenderOrigin;
let discovery: ConfigDiscovery;
let watchers: WatcherRegistry;
let moved: SessionId[][];

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccb-discovery-")));
  file = path.join(dir, "config.json5");
  fs.writeFileSync(file, `{ segments: {} }`);
  origin = { projectDir: dir, cwd: dir, target: { source: "argument", path: file } };
  const host = hostOf(
    { ...HOST.env, XDG_CONFIG_HOME: path.join(dir, "xdg") },
    { home: path.join(dir, "home") },
  );
  watchers = new WatcherRegistry({ clock: systemTimekeeper, logger: () => {} });
  moved = [];
  discovery = new ConfigDiscovery({
    world: { locations: locations(host), stateDir: stateDir(host) },
    watchers,
    moved: (sessions) => moved.push([...sessions]),
    heard: () => {},
    log: () => {},
  });
});

afterEach(() => {
  discovery.close();
  watchers.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

const query = () => ({ projectDir: dir, cwd: dir, configFile: file });
const textOf = (snapshot: ConfigSnapshot): string | null => {
  const content = snapshot.chain.find((l) => l.path === file)?.content;
  return content?.kind === "text" ? content.text : null;
};

describe("the host's config discovery", () => {
  test("sessions naming one origin share its discovery and its watch, which goes with the last of them", () => {
    const before = watchers.size();
    const first = discovery.at(S1, query());
    expect(discovery.at(S2, query())).toBe(first);
    const held = watchers.size();
    expect(held).toBeGreaterThan(before);
    discovery.retire(S1);
    expect(watchers.size()).toBe(held);
    discovery.retire(S2);
    expect(watchers.size()).toBe(before);
  });

  test("a landed write moves the sessions whose chain holds the file, once", () => {
    discovery.at(S1, query());
    fs.writeFileSync(file, `{ segments: { a: { template: "a" } } }`);
    expect(discovery.landed([file], false)).toEqual([S1]);
    expect(textOf(discovery.snapshotOf(S1)!)).toContain(`template: "a"`);
    expect(discovery.landed([file], false)).toEqual([]);
    expect(discovery.landed([path.join(dir, "other.json5")], false)).toEqual([]);
  });

  test("a click reads the files as they are now, and hands every other session naming them the snapshot that moved", () => {
    discovery.at(S1, query());
    discovery.at(S2, query());
    fs.writeFileSync(file, `{ segments: { b: { template: "b" } } }`);
    const config = discovery.current(S1, origin)!;
    expect(config.origin).toBe(origin);
    expect(textOf(config.snapshot)).toContain(`template: "b"`);
    expect(moved).toEqual([[S2]]);
  });

  test("a click on a session no request has reached is found at the origin its last draw recorded; a session never drawn has none", () => {
    discovery.recorded(S3, origin);
    const config = discovery.current(S3, null)!;
    expect(config).toMatchObject({ session: S3, origin });
    expect(textOf(config.snapshot)).toBe(`{ segments: {} }`);
    expect(discovery.current(S1, null)).toBeNull();
  });

  test("a hand edit the watch hears moves the session naming the file", async () => {
    discovery.at(S1, query());
    fs.writeFileSync(file, `{ segments: { c: { template: "c" } } }`);
    await until(() => moved.some((m) => m.includes(S1)), "the edit heard");
    expect(textOf(discovery.snapshotOf(S1)!)).toContain(`template: "c"`);
  });
});
