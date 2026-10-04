// The bar in a browser terminal you can click: an isolated real daemon, drawn
// by xterm.js, every link a click the daemon runs.
//
//   pnpm bar:web                           the bundled bar, at http://127.0.0.1:7317/
//   pnpm bar:web --ssh                     …with the host segment showing
//   pnpm bar:web --config my.json5         a config of your own (a copy: clicks never touch it)
//   pnpm bar:web --port 0                  any free port
//
// The server is scripts/bar-web/server.ts; the bar it drives is test/helpers/drive-bar.ts.

import path from "node:path";
import { parseArgs } from "node:util";

import { serveBar } from "./bar-web/server";

const invokedIn = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "7317" },
      config: { type: "string" },
      cwd: { type: "string", default: invokedIn },
      ssh: { type: "boolean", default: false },
    },
  });
  if (!/^\d+$/.test(values.port)) throw new Error(`--port must be a whole number, got "${values.port}"`);
  const web = await serveBar({
    port: Number(values.port),
    assets: path.join(path.dirname(new URL(import.meta.url).pathname), "bar-web"),
    // The page reports its terminal's size with every request; this is only the first render's.
    width: 120,
    rows: 40,
    config: values.config === undefined ? null : path.resolve(invokedIn, values.config),
    cwd: path.resolve(invokedIn, values.cwd),
    ssh: values.ssh,
  });
  console.log(`the live bar: ${web.url}  (ctrl-c stops it and its daemon)`);
  const stop = (): void => {
    void web.close().then(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
