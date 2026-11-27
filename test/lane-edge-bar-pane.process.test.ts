import net from "node:net";
import { pathToFileURL } from "node:url";
import {
  encodeFrame,
  makeFrameReader,
} from "../src/daemon/foundations/protocol";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { productionBarPaneEdge } from "../src/daemon/lane-edge";
import { processLauncher } from "./helpers/host";
import { tmuxServer, type TmuxServer } from "./helpers/private-tmux";
import { until } from "../scripts/lib/until";
import type { TmuxHint } from "../src/tmux-hint";

describe("a managed drawing pane on its private server", () => {
  let dir: string, server: TmuxServer, source: TmuxHint, serverPid: number;
  const host = {
    node: ["/bin/sh", "-c", "exec sleep 60"],
    bundle: "fixture 'with spaces'",
    socket: "/no daemon in this fixture",
  };
  const edge = () => productionBarPaneEdge(processLauncher);
  const panes = () =>
    server.run("list-panes", "-a", "-F", "#{pane_id}").trim().split("\n");
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "ccb-managed-pane-"));
    server = tmuxServer(dir, { cols: 100, rows: 30 });
    source = { pane: server.pane, socket: server.socket, truecolor: null };
    serverPid = Number(
      server.run("display-message", "-p", "-t", source.pane, "#{pid}").trim(),
    );
  });
  afterEach(() => {
    server.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a fresh host recovers the split whose reply was lost, ignoring another command ending in bar-pane and preserving focus", async () => {
    const other = server
      .run(
        "split-window",
        "-h",
        "-t",
        source.pane,
        "-PF",
        "#{pane_id}",
        "/bin/sh",
        "-c",
        "exec sleep 60",
        "bar-pane",
        source.pane,
      )
      .trim();
    const instance = randomUUID();
    // Drop the opening adapter and its reply after the real server commits.
    await edge().open(source, serverPid, host, instance);
    const updatedHost = {
      ...host,
      node: ["/updated/node"],
      bundle: "/updated/bundle",
    };
    const recovered = await edge().find(source, serverPid, updatedHost);
    expect(recovered).toMatchObject({ instance });
    if (!recovered || !("instance" in recovered))
      throw new Error("managed pane missing");
    expect(panes()).toHaveLength(3);
    expect(
      server.run("display-message", "-p", "-t", "bar", "#{pane_id}").trim(),
    ).toBe(other);
    expect(
      await edge().find(source, serverPid, {
        ...host,
        socket: host.socket + "-other",
      }),
    ).toBeNull();
    await expect(edge().find(source, serverPid + 1, host)).rejects.toThrow(
      "different server",
    );
    await expect(
      edge().retire(source, serverPid, host, {
        ...recovered,
        instance: randomUUID(),
      }),
    ).rejects.toThrow("changed before retirement");
    expect(panes()).toContain(recovered.drawing);
    await edge().retire(source, serverPid, updatedHost, recovered);
    expect(panes()).toEqual(expect.arrayContaining([source.pane, other]));
    expect(panes()).toHaveLength(2);
  });
  test("failure before the follower starts removes only the split while the source keeps its remain-on-exit and pane-died hook", async () => {
    server.run("set-option", "-gw", "remain-on-exit", "on");
    server.run("set-hook", "-g", "pane-died", "set-option -g @test-died yes");
    const hook = server.run("show-hooks", "-g", "pane-died");
    const broken = { ...host, node: ["/no/such/candybar"], bundle: "unused" };
    const pane = await edge().open(source, serverPid, broken, randomUUID());
    await until(
      () => !panes().includes(pane.drawing),
      "failing follower removed",
    );
    expect(panes()).toEqual([source.pane]);
    expect(
      server
        .run("display-message", "-p", "-t", source.pane, "#{remain-on-exit}")
        .trim(),
    ).toBe("on");
    expect(server.run("show-options", "-gqv", "@test-died")).toBe("");
    expect(server.run("show-hooks", "-g", "pane-died")).toBe(hook);
  });
  test("a legacy launch with a different socket survives; a verified legacy follower can be retired", async () => {
    const folder = path.join(dir, "legacy 'with spaces'");
    writeFileSync(
      folder,
      `const net=require('node:net');const s=net.createConnection(process.env.CC_CANDYBAR_SOCKET);s.on('connect',()=>s.write('ready'));s.resume();`,
    );
    const socket = path.join(dir, "daemon.sock"),
      other = path.join(dir, "other.sock");
    const clients: net.Socket[] = [];
    const listen = async (name: string) => {
      const server = net.createServer((sock) =>
        sock.once("data", () => clients.push(sock)),
      );
      await new Promise<void>((resolve, reject) =>
        server.once("error", reject).listen(name, resolve),
      );
      return server;
    };
    const ours = await listen(socket),
      theirs = await listen(other);
    const host = { node: [process.execPath], bundle: folder, socket };
    const start = (address: string) =>
      server
        .run(
          "split-window",
          "-d",
          "-t",
          source.pane,
          "-PF",
          "#{pane_id}",
          "-e",
          "CC_CANDYBAR_SOCKET=" + address,
          ...host.node,
          host.bundle,
          "bar-pane",
          source.pane,
        )
        .trim();
    try {
      const foreign = start(other);
      await until(
        () => clients.length === 1,
        "legacy follower connected elsewhere",
      );
      expect(await edge().find(source, serverPid, host)).toMatchObject({
        drawing: foreign,
        grant: "unknown",
      });
      expect(panes()).toContain(foreign);
      server.run("kill-pane", "-t", foreign);
      const owned = start(socket);
      await until(
        () => clients.length === 2,
        "legacy follower connected to the fixture host",
      );
      const found = await edge().find(source, serverPid, host);
      if (!found || !("grant" in found))
        throw Error("legacy argv was not recognized");
      if (process.platform === "darwin") {
        expect(found.grant).toBe("connected");
        await edge().retire(source, serverPid, host, {
          ...found,
          grant: "connected",
        });
        expect(panes()).not.toContain(owned);
      } else {
        expect(found.grant).toBe("unknown");
        expect(panes()).toContain(owned);
      }
    } finally {
      for (const client of clients) client.destroy();
      await Promise.all(
        [ours, theirs].map((s) => new Promise<void>((r) => s.close(() => r()))),
      );
    }
  });

  test("the live follower handles resize, zoom, mouse and refusal on one addressed stream", async () => {
    const pathName = path.join(dir, "feed.sock");
    let wire: net.Socket | undefined;
    let enrollments = 0;
    const actions: string[] = [];
    let pointer: string | null = null;
    const ports = new Set<net.Socket>();
    const listener = net.createServer((sock) => {
      ports.add(sock);
      sock.on("close", () => ports.delete(sock));
      sock.on(
        "data",
        makeFrameReader(
          (raw) => {
            const req = raw as {
              kind: string;
              url: string;
              owner: { hover: string | null };
            };
            if (req.kind === "pane-enroll") {
              wire = sock;
              enrollments++;
            } else {
              if (req.kind === "click") actions.push(req.url);
              if (req.kind === "pointer") pointer = req.owner.hover;
              sock.end(encodeFrame({ ok: true, output: "" }));
            }
            return "done";
          },
          (error) => sock.destroy(error),
        ),
      );
    });
    await new Promise<void>((resolve, reject) =>
      listener.once("error", reject).listen(pathName, resolve),
    );
    try {
      const entry = path.join(dir, "follow.mjs");
      const src = (file: string) =>
        pathToFileURL(path.resolve(__dirname, "../src", file)).href;
      writeFileSync(
        entry,
        `import { runBarPane } from ${JSON.stringify(src("bar-pane/index.ts"))};\nimport { processWorld } from ${JSON.stringify(src("host.ts"))};\nprocess.exitCode=await runBarPane(process.argv.slice(3),processWorld());`,
      );
      const fixture = {
        node: [process.execPath, "--import", require.resolve("tsx")],
        bundle: entry,
        socket: pathName,
      };
      const pane = await edge().open(source, serverPid, fixture, randomUUID());
      await until(() => wire !== undefined, "real follower's hello");
      const frame = (output: string, shown = true, zoomed = false) =>
        wire!.write(
          encodeFrame({
            kind: "pane-state",
            owner: pane.instance,
            session: "physical-test",
            shown,
            zoomed,
            mouse: true,
            frame: {
              ok: true,
              output,
              hits: [
                [
                  {
                    from: 0,
                    to: 1,
                    action: "fixture",
                    links: { left: "fixture-click" },
                  },
                ],
              ],
            },
          }),
        );
      const read = (format: string) =>
        server.run("display-message", "-p", "-t", pane.drawing, format).trim();
      frame("a\nb");
      await until(() => read("#{pane_height}") === "2", "two-row managed pane");
      server.run("resize-pane", "-Z", "-t", pane.drawing);
      // Even a stale visible update cannot unzoom a user's newly zoomed pane.
      frame("z");
      frame("zoomed", true, true);
      server.run("send-keys", "-t", pane.drawing, "-l", "\x1b[<35;1;1M");
      await until(
        () => pointer === "fixture",
        "pointer on zoomed drawing pane",
      );
      expect(read("#{window_zoomed_flag}")).toBe("1");
      server.run("resize-pane", "-Z", "-t", pane.drawing);
      frame("a");
      await until(() => read("#{pane_height}") === "1", "one row after unzoom");
      server.run("select-pane", "-t", source.pane);
      server.run("select-pane", "-t", pane.drawing);
      server.run("send-keys", "-t", pane.drawing, "-l", "\x1b[<0;1;1M");
      await until(
        () =>
          actions.includes("fixture-click") && read("#{pane_active}") === "0",
        "click and return to source",
      );
      expect(enrollments).toBe(1);
      wire!.end(
        encodeFrame({
          ok: false,
          code: "SWITCHED_OFF",
          error: "setting disabled",
        }),
      );
      await until(
        () => !panes().includes(pane.drawing),
        "follower exited on surface refusal",
      );
      expect(enrollments).toBe(1);
    } finally {
      for (const sock of ports) sock.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });
});
