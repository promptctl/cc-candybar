// [LAW:verifiable-goals] `pnpm bar:web` (scripts/bar-web/server.ts) promises:
// the page and its font are served; a render comes back at the size the page
// reports, with every link it drew and what a click on it fires; a click on a
// drawn link lands in the daemon and the answer is the next render; a click on
// a link the last render no longer draws is refused, naming it; a size that is
// not whole cells is refused.

import path from "node:path";

import { serveBar, type BarWeb, type View } from "../scripts/bar-web/server";
import { DOOR_CLOSE_GLYPH, DOOR_GLYPH } from "../src/config/disclosure";
import { stripAnsi } from "./helpers/ansi";

jest.setTimeout(30_000);

const ASSETS = path.join(process.cwd(), "scripts/bar-web");

describe("bar-web", () => {
  let web: BarWeb | undefined;
  afterEach(async () => web?.close());

  const post = async (route: string, body: object): Promise<{ status: number; json: View & { error?: string } }> => {
    const res = await fetch(new URL(route, web!.url), { method: "POST", body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as View & { error?: string } };
  };

  test("serves the page and the Powerline font", async () => {
    web = await serveBar({ port: 0, assets: ASSETS, width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    const page = await fetch(web.url);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("linkHandler");
    const font = await fetch(new URL("/rich-powerline.woff2", web.url));
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  test("a click on a drawn link is the daemon's click, and the answer is the next render", async () => {
    web = await serveBar({ port: 0, assets: ASSETS, width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    const closed = await post("/render", { width: 80, rows: 40 });
    expect(closed.status).toBe(200);
    expect(stripAnsi(closed.json.ansi).split("\n").every((l) => [...l].length <= 80)).toBe(true);
    const door = closed.json.links.find((l) => l.text === DOOR_GLYPH)!;
    expect(door.does).toMatch(/^set-state <session> candybar\.menu open/);

    const opened = await post("/click", { url: door.url, width: 80, rows: 40 });
    expect(opened.status).toBe(200);
    expect(opened.json.refused).toBeNull();
    expect(opened.json.links.map((l) => l.text)).toContain(DOOR_CLOSE_GLYPH);

    // The door's closed-state link is no longer drawn: refused, named.
    const stale = await post("/click", { url: door.url, width: 80, rows: 40 });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toContain(door.url);
  });

  test("a size that is not whole cells is refused", async () => {
    web = await serveBar({ port: 0, assets: ASSETS, width: 120, rows: 40, config: null, cwd: process.cwd(), ssh: false });
    const bad = await post("/render", { width: 0, rows: 40 });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/width and rows/);
  });
});
