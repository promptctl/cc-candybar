// The bar in a browser terminal: `pnpm bar:web` serves a page whose xterm.js
// terminal shows what the isolated daemon renders, and sends every link the
// reader clicks back to that daemon as the click it is.
//
// [LAW:single-enforcer] The daemon, the render request and the click are
// test/helpers/drive-bar.ts — the same bar `pnpm bar` drives. This file only
// carries its renders out over HTTP and its clicks back in.
//
// [LAW:no-silent-failure] Every answer names what happened: the render, every
// link it drew with the effects a click fires, and why the last click did
// nothing when it did nothing. A click on a link the last render no longer
// draws is a 409 naming it, never a guess at what the reader meant.
//
// Only the page drives it: a request must be JSON (so another site's page
// needs a preflight this server never answers) sent to this server's own host
// (so a rebound DNS name reaches nothing).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";

import {
  describeLink,
  drawnLinks,
  NotDrawnError,
  startBar,
  type Bar,
  type BarOptions,
  type Clicked,
  type TerminalSize,
} from "../../test/helpers/drive-bar";

// What the page draws: the bytes, every link in them, and why a click did nothing.
export interface View {
  readonly ansi: string;
  readonly links: readonly { text: string; url: string; does: string }[];
  readonly refused: string | null;
}

export interface BarWeb {
  readonly url: string;
  close(): Promise<void>;
}

const ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/rich-powerline.woff2": { file: "rich-powerline.woff2", type: "font/woff2" },
};

const view = (ansi: string, refused: string | null): View => ({
  ansi,
  links: drawnLinks(ansi).map((l) => ({ ...l, does: describeLink(l) })),
  refused,
});

// A size the page reports: whole numbers ≥ 1, or the request is refused.
function sizeOf(body: Record<string, unknown>): TerminalSize {
  const { width, rows } = body;
  if (!Number.isInteger(width) || !Number.isInteger(rows) || (width as number) < 1 || (rows as number) < 1) {
    throw new HttpError(400, `width and rows must be whole numbers ≥ 1, got ${JSON.stringify({ width, rows })}`);
  }
  return { width: width as number, rows: rows as number };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, `the body must be sent as application/json, got ${req.headers["content-type"] ?? "no content-type"}`);
  }
  let text = "";
  for await (const chunk of req) text += chunk;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text === "" ? "{}" : text);
  } catch (e) {
    throw new HttpError(400, `the body is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "the body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export interface ServeOptions extends BarOptions {
  readonly port: number;
  /** The directory holding the page and its font (scripts/bar-web). */
  readonly assets: string;
}

export async function serveBar(opts: ServeOptions): Promise<BarWeb> {
  let bar: Bar = await startBar(opts);
  // One bar, one reader: requests run one at a time, so a click always
  // follows the render the page last drew.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const routes: Readonly<Record<string, (body: Record<string, unknown>) => Promise<View>>> = {
    "/render": async (body) => {
      bar.resize(sizeOf(body));
      return view(await bar.render(), null);
    },
    "/click": async (body) => {
      bar.resize(sizeOf(body));
      if (typeof body.url !== "string") throw new HttpError(400, "url must be a string");
      const clicked: Clicked = await bar.follow(body.url).catch((e: unknown) => {
        throw e instanceof NotDrawnError ? new HttpError(409, e.message) : e;
      });
      return view(clicked.rendered, clicked.refused);
    },
    // A new session on a fresh daemon and an untouched copy of the config. The
    // old bar is stopped only once the new one runs, so a failed start leaves
    // the page on a working bar.
    "/restart": async (body) => {
      const next = await startBar({ ...opts, ...sizeOf(body) });
      bar.stop();
      bar = next;
      return view(await bar.render(), null);
    },
  };

  let host = "";
  const server = http.createServer((req, res) => {
    const send = (status: number, type: string, payload: string | Buffer): void => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(payload);
    };
    const fail = (status: number, error: string): void => send(status, "application/json", JSON.stringify({ error }));
    if (req.headers.host !== host) {
      fail(421, `this server answers only as ${host}, not ${req.headers.host ?? "no host"}`);
      return;
    }
    const asset = req.method === "GET" ? ASSETS[req.url ?? ""] : undefined;
    if (asset !== undefined) {
      send(200, asset.type, fs.readFileSync(path.join(opts.assets, asset.file)));
      return;
    }
    const route = req.method === "POST" ? routes[req.url ?? ""] : undefined;
    if (route === undefined) {
      fail(404, `no ${req.method} ${req.url}`);
      return;
    }
    serial(async () => route(await readJson(req))).then(
      (v) => send(200, "application/json", JSON.stringify(v)),
      (e: unknown) => fail(e instanceof HttpError ? e.status : 500, e instanceof Error ? e.message : String(e)),
    );
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port, "127.0.0.1", resolve);
    });
  } catch (e) {
    bar.stop();
    throw e;
  }
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `http://${host}/`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      bar.stop();
    },
  };
}
