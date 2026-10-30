// [LAW:no-silent-failure] A failure whose error has an empty stack prints as
// its title and blank lines, because jest draws a failure from its error's
// stack alone. jest's teardown empties the stack of every Error that an ended
// test file's leftover code makes later (it sets that file's
// `Error.prepareStackTrace` to return ""), and charges the throw to whichever
// test the worker is running then. The message survives in the result's
// failure messages, so for those failures only, this prints it and the file
// the throw landed in, which is where it landed and rarely the file that threw.
//
// The error itself never reaches a reporter (a result carries a copy without
// its stack), so a stackless failure is known by what jest printed for it:
// its block in the file's report, empty under its title.

import path from "node:path";

const ANSI = /\x1b\[[0-9;]*m/g;

// Each failure block in a file's report: the title after `●`, and whether
// anything was printed under it.
function blocksOf(report) {
  return report
    .replace(ANSI, "")
    .split(/^(?= {2}● )/m)
    .filter((block) => block.startsWith("  ● "))
    .map((block) => {
      const [title, ...body] = block.slice("  ● ".length).split("\n");
      return { title, empty: body.join("\n").trim() === "" };
    });
}

export default class StacklessFailureReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
  }

  onTestResult(_test, result) {
    const blocks = blocksOf(result.failureMessage ?? "");
    const file = path.relative(this.rootDir, result.testFilePath);
    for (const test of result.testResults) {
      const title = [...test.ancestorTitles, test.title].join(" › ");
      const own = blocks.filter((block) => block.title === title);
      test.failureMessages.forEach((message, i) => {
        if (own[i]?.empty !== true) return;
        process.stderr.write(
          `  ● ${title}\n\n` +
            `    thrown with an empty stack while ${file} was running: ${message}\n\n`,
        );
      });
    }
  }
}
