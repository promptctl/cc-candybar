import { stageExecutable } from "../src/install/stage-executable.js";

const [, , source, destination] = process.argv;
if (!source || !destination)
  throw new Error("usage: stage-executable <source> <destination>");
stageExecutable(source, destination);
