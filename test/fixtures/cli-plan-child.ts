// A command that delivers one plan: a stdout body of the size argv names, a
// stderr line, and the exit code argv names. test/cli-plan.test.ts spawns it
// with its streams piped, the shape every subcommand's delivery has.
import { exitWith } from "../../src/cli-plan";

const [bytes, code] = process.argv.slice(2).map(Number) as [number, number];
void exitWith({
  stdout: "x".repeat(bytes - 1) + "\n",
  stderr: "advisory\n",
  code,
});
