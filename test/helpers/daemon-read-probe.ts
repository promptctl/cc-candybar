import fs from "node:fs";

export interface Read {
  readonly file: string;
  readonly pid: number;
  readonly operation: string;
}

// The probe counts filesystem calls for the exact
// fixture paths. Child renderers inherit the preload as well.
export function readProbe(
  file: string,
  output: string,
  selected: Readonly<Record<string, readonly string[]>>,
): void {
  fs.writeFileSync(
    file,
    `
    const fs = require("node:fs");
    const fsp = require("node:fs/promises");
    const { syncBuiltinESMExports } = require("node:module");
    const wanted = ${JSON.stringify(selected)};
    const append = fs.appendFileSync;
    const tracked = new Map();
    const record = (file, operation) => append(${JSON.stringify(output)}, JSON.stringify({file,pid:process.pid,operation}) + "\\n");
    for (const [api, name] of [[fs,"openSync"], [fsp,"open"], [fsp,"readFile"]]) {
      const original = api[name];
      api[name] = function (file, ...rest) {
        const result = original.call(this, file, ...rest);
        if (typeof file === "string" && wanted[file]?.includes(name)) record(file, name);
        if (name === "openSync" && typeof file === "string" && wanted[file]?.includes("payload")) tracked.set(result, file);
        return result;
      };
    }
    const readFileSync = fs.readFileSync;
    fs.readFileSync = function (file, ...rest) {
      const payload = typeof file === "string" && wanted[file]?.includes("payload") ? file : tracked.get(file);
      if (payload !== undefined) record(payload, "payload");
      return readFileSync.call(this, file, ...rest);
    };
    const closeSync = fs.closeSync;
    fs.closeSync = function (fd) {
      tracked.delete(fd);
      return closeSync.call(this, fd);
    };
    syncBuiltinESMExports();
  `,
  );
}

export function readsOf(file: string): Read[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Read);
}
