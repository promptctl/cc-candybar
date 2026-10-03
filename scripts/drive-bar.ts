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

// A count of columns or rows: a whole number ≥ 1, or the run stops naming it.
function cells(flag: string, raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`--${flag} must be a whole number ≥ 1, got "${raw}"`);
  return Number(raw);
}

// `pnpm bar` runs in the package root; paths mean what they meant where it was typed.
const invokedIn = process.env.INIT_CWD ?? process.cwd();

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      width: { type: "string", default: "120" },
      rows: { type: "string", default: "40" },
      config: { type: "string" },
      cwd: { type: "string", default: invokedIn },
      ssh: { type: "boolean", default: false },
      links: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const bar = await startBar({
    width: cells("width", values.width),
    rows: cells("rows", values.rows),
    config: values.config === undefined ? null : path.resolve(invokedIn, values.config),
    cwd: path.resolve(invokedIn, values.cwd),
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
