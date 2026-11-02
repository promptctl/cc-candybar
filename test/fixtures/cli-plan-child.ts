// A command that delivers one plan: a stdout body of the size argv names, a
// stderr line, and the exit code argv names. test/cli-plan.test.ts spawns it
// with its streams piped, the shape every subcommand's delivery has.
import { exitWith } from "../../src/cli-plan";
import { setDebug } from "../../src/utils/logger";

// A process main of its own: it sets the debug channel from its environment, as
// src/index.ts does.
setDebug(Boolean(process.env.CC_CANDYBAR_DEBUG));

const [bytes, code] = process.argv.slice(2).map(Number) as [number, number];
void exitWith({
  stdout: "x".repeat(bytes - 1) + "\n",
  stderr: "advisory\n",
  code,
});
