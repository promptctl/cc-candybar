// [LAW:behavior-not-structure] A click's write lands on the disk its home was
// found on: the text it splices, the chain it proves and the file it writes
// are one disk's.

import path from "node:path";
import { filesystemFake } from "../../src/disk/filesystem-fake";
import { heldClock } from "../helpers/held-clock";
import { InstalledLayerMemo } from "../../src/config/dsl-loader";
import { durableConfig } from "../../src/config/loader/discovery";
import { writeValues } from "../../src/daemon/config-file-store";
import type { Locations } from "../../src/daemon/paths";

const root = "/w";
const locs: Locations = {
  homeDir: path.join(root, "home"),
  configDir: path.join(root, "xdg", "cc-candybar"),
  dataHome: path.join(root, "data"),
  dataDirs: [],
};
const userFile = path.join(locs.configDir, "config.json5");
const noRecord = { record: () => {}, logger: () => {} };

test("a value click splices the home on its disk and writes it there", () => {
  const disk = filesystemFake({
    clock: heldClock(new Date(0)),
    platform: "darwin",
  });
  disk.mkdir(locs.configDir);
  disk.write(userFile, `{ globals: { menuGlyph: "U" } }`);
  const home = durableConfig(
    disk,
    new InstalledLayerMemo(),
    locs,
    { kind: "ok", value: {} },
    undefined,
    root,
  );
  expect(home.path).toBe(userFile);
  writeValues(noRecord, home, [["palette", "nord"]]);
  const written = disk.readFileSync(userFile);
  expect(written).toContain(`menuGlyph: "U"`);
  expect(written).toContain("nord");
});
