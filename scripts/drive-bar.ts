// Drive the bar the way a user does: render it, click what it drew, render again.
//
//   pnpm bar                                 the bundled bar, 120 columns
//   pnpm bar 🍫 "🎨 look"                    open the menu, then its look tab
//   pnpm bar --width 80 --links 🍫           …and list every link the last render drew
//   pnpm bar --config my.json5 ▸             a config of your own (a copy: clicks never touch it)
//   pnpm bar ✎ "▸#2"                         `text#n` clicks the n-th link reading `text` (from 1)
//
// The bar itself — isolated daemon, render, click — is test/helpers/drive-bar.ts.

import path from "node:path";
import { parseArgs } from "node:util";

import {
  describeLink,
  drawnLinks,
  printable,
  startBar,
} from "../test/helpers/drive-bar";

// `text#n` → the n-th link reading `text`; a bare `text` is the first.
function parseStep(step: string): [string, number] {
  const m = /^(.*)#(\d+)$/.exec(step);
  return m === null ? [step, 1] : [m[1]!, Number(m[2])];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      width: { type: "string", default: "120" },
      rows: { type: "string", default: "40" },
      config: { type: "string" },
      cwd: { type: "string", default: process.cwd() },
      ssh: { type: "boolean", default: false },
      links: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const bar = await startBar({
    width: Number(values.width),
    rows: Number(values.rows),
    config: values.config ?? null,
    cwd: path.resolve(values.cwd),
    ssh: values.ssh,
  });
  try {
    let out = await bar.render();
    console.log(`--- closed\n${printable(out)}`);
    for (const step of positionals) {
      const clicked = await bar.click(...parseStep(step));
      out = clicked.rendered;
      const refused = clicked.refused === null ? "" : `  (refused: ${clicked.refused})`;
      console.log(`--- ${step}${refused}\n${printable(out)}`);
    }
    if (values.links) {
      for (const link of drawnLinks(out)) {
        console.log(`  ${JSON.stringify(link.text)} → ${describeLink(link)}`);
      }
    }
  } finally {
    bar.stop();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
