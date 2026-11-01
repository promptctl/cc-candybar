// [LAW:verifiable-goals] brandon-menus-sjhy.5y2: hovering a button shows a URL
// that says what the click will do. test/click-wire.test.ts pins the words, and
// a pin freezes whatever its author read, so this holds them to the bar's real
// clicks by facts that do not come from the table that wrote them: two different
// clicks on one screen never read alike, a click that acts on the world never
// reads as a session write, and the words change nothing about the click.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DOOR_GLYPH } from "../src/config/disclosure";
import { effectsOf, isBarLink } from "../src/click/read";
import {
  linksOf,
  startBar,
  type Bar,
  type DrawnLink,
} from "./helpers/drive-bar";
import { textOf, type Frame } from "../src/render/frame";
import { startBarDaemon } from "./helpers/in-worker-daemon";

jest.setTimeout(60_000);

const CLICKS = 150;

// The words a link says, as a hover's reader decodes them; empty on a link with
// none.
const doesOf = (url: string): string =>
  new URLSearchParams(url.split("/dispatch/")[1] ?? "").get("does") ?? "";
const withoutDoes = (url: string): string => url.replace(/does=[^&]*&/, "");
const barLinks = (rendered: Frame): DrawnLink[] =>
  linksOf(rendered).filter((l) => isBarLink(l.url));

// What a walk clicks ahead of any other new link: what only a click brings into
// view, and these are the frames where different clicks differ least. A confirm
// shows only once armed, and an insert list only from arrange mode, beside the
// segment it inserts after.
const DRAWN_ONLY_AFTER = [
  /\.armed to armed$/,
  /^set edit\.mode to arrange/,
  /^open edit\.default\.insert\./,
  /^turn .* to page /,
];

// Every `2/6` a frame draws: where each paged list stands.
const positionsIn = (rendered: Frame): string[] =>
  textOf(rendered).match(/\d+\/\d+/g) ?? [];

// The positions in `after` that `before` does not hold, counted one for one, so
// a list that moved stands out from the siblings at the same position.
const moved = (before: readonly string[], after: readonly string[]): string[] =>
  before.reduce(
    (rest, p) => rest.filter((q, i) => i !== rest.indexOf(p)),
    [...after],
  );

// A click that named a page, and the positions the bar drew around it.
interface Turn {
  readonly page: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}
interface Walked {
  readonly frames: DrawnLink[][];
  readonly turns: Turn[];
}

// Every frame a walk of the bar draws: from the open door, each click takes a
// link not yet clicked, those first. A frame with nothing new moves on through
// its first link.
async function walk(bar: Bar): Promise<Walked> {
  await bar.render();
  const opened = (await bar.click(DOOR_GLYPH)).rendered;
  const frames = [barLinks(opened)];
  const turns: Turn[] = [];
  let before = positionsIn(opened);
  const clicked = new Set<string>();
  for (let n = 0; n < CLICKS; n++) {
    const frame = frames.at(-1)!;
    const fresh = frame.filter((l) => !clicked.has(l.url));
    const next =
      DRAWN_ONLY_AFTER.flatMap((drawn) =>
        fresh.filter((l) => drawn.test(doesOf(l.url))),
      )[0] ??
      fresh[0] ??
      frame[0];
    if (next === undefined) break;
    clicked.add(next.url);
    const { rendered } = await bar.follow(next.url);
    frames.push(barLinks(rendered));
    const after = positionsIn(rendered);
    const page = /to page (\d+)/.exec(doesOf(next.url))?.[1];
    if (page !== undefined) turns.push({ page, before, after });
    before = after;
  }
  return { frames, turns };
}

// The example config, where its plugin's path still reads: a bar copies the
// config it is given into a scratch directory.
function pluginConfig(): string {
  const example = path.resolve("examples/plugin-deploy.json5");
  const config = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "click-does-")),
    "config.json5",
  );
  fs.writeFileSync(
    config,
    fs
      .readFileSync(example, "utf8")
      .replace("./plugins", path.join(path.dirname(example), "plugins")),
  );
  return config;
}

describe.each([
  ["the default bar", () => null],
  ["a bar with a plugin's long segment name", pluginConfig],
])("%s: its links say what their clicks do", (_, config) => {
  let bar: Bar;
  let frames: DrawnLink[][];
  let turns: Turn[];
  let links: DrawnLink[];

  beforeAll(async () => {
    bar = await startBar(
      {
        width: 160,
        rows: 60,
        config: config(),
        cwd: process.cwd(),
        ssh: false,
      },
      startBarDaemon,
    );
    ({ frames, turns } = await walk(bar));
    links = [...new Map(frames.flat().map((l) => [l.url, l])).values()];
  });
  afterAll(async () => bar.stop());

  test("the walk reaches a confirm, an insert list and a stepper's two directions", () => {
    const texts = links.map((l) => doesOf(l.url));
    expect(texts).toContain("type /clear and 1 more");
    expect(texts.some((t) => t.startsWith("edit insert:"))).toBe(true);
    expect(texts.some((t) => t.startsWith("reset "))).toBe(true);
    expect(texts.some((t) => /^step .* up by /.test(t))).toBe(true);
    expect(texts.some((t) => /^step .* down by /.test(t))).toBe(true);
  });

  test("a link that names a page lands on the page the bar numbers so", () => {
    expect(turns.length).toBeGreaterThan(0);
    for (const { page, before, after } of turns)
      expect(moved(before, after)).toEqual([
        expect.stringMatching(new RegExp(`^${page}/`)),
      ]);
  });

  test("no link's words hold a number the bar never shows", () => {
    expect(
      links.map((l) => doesOf(l.url)).filter((t) => /\d{7,}/.test(t)),
    ).toEqual([]);
  });

  test("every bar link says something, in printable ASCII", () => {
    expect(links.filter((l) => doesOf(l.url) === "")).toEqual([]);
    expect(links.filter((l) => !/^[\x21-\x7e]+$/.test(l.url))).toEqual([]);
  });

  test("two different clicks on one screen never read alike", () => {
    const alike = frames.flatMap((frame) => {
      const urls = new Map<string, Set<string>>();
      for (const { url } of frame)
        urls.set(doesOf(url), (urls.get(doesOf(url)) ?? new Set()).add(url));
      return [...urls].filter(([, set]) => set.size > 1).map(([text]) => text);
    });
    expect(alike).toEqual([]);
  });

  test("a click that acts beyond the session never reads as a session write", () => {
    const acting = links.filter((l) =>
      effectsOf(l.url).some(
        (e) => e.verb !== "set-state" && e.verb !== "step-state",
      ),
    );
    expect(acting.length).toBeGreaterThan(0);
    expect(
      acting
        .map((l) => doesOf(l.url))
        .filter((t) => /^(set|close|turn) /.test(t)),
    ).toEqual([]);
  });

  test("the words change nothing about the click", () => {
    for (const { url } of links)
      expect(effectsOf(url)).toEqual(effectsOf(withoutDoes(url)));
  });
});
