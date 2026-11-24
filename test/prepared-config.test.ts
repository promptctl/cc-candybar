// A prepared config draws as a session does: its sample is bound before the
// draw waits on what the bind started.

import fs from "node:fs";
import path from "node:path";

import { textOf } from "../src/render/frame";
import { WORLD } from "./helpers/host";
import {
  expectClean,
  renderConfig,
  withTempConfig,
} from "./helpers/config-fixture";

// [LAW:behavior-not-structure] The file first names a run when the sampled
// width is bound. A draw that waited too early still shows the fallback.
test("a prepared sample draws the file value keyed on its bound width", async () => {
  await withTempConfig("", async (file) => {
    const cwd = path.dirname(file);
    const source = path.join(cwd, "reading.txt");
    fs.writeFileSync(source, "current reading");
    fs.writeFileSync(
      file,
      `{
      variables: {
        columns: { kind: 'input', path: 'term.cols', type: 'number' },
        reading: {
          kind: 'file', path: ${JSON.stringify(source)}, default: 'waiting',
          cache: { depends_on: ['columns'] },
        },
      },
      segments: { probe: { template: 'cols={{ .columns }} {{ .reading }}' } },
      root: { h: ['probe'] },
    }`,
    );
    const outcome = expectClean(
      "keyed sample",
      await renderConfig(WORLD, file, cwd),
    );
    expect(textOf(outcome.rendered)).toContain("cols=200 current reading");
  });
});
