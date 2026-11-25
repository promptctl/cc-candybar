// [LAW:verifiable-goals] The URL handler's wire reads (url-handler/wire.swift):
// which daemon a link names, which forwards that daemon's id names and the host
// each carries, the frame it sends, and how it reads the verdict, run by the
// compiler that builds the app. Swift builds on macOS only.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CHECK = path.resolve("url-handler/check.sh");

jest.setTimeout(180_000);

(process.platform === "darwin" ? test : test.skip)(
  "every expectation of the URL handler's wire reads holds",
  async () => {
    const { stdout } = await exec("sh", [CHECK], { timeout: 170_000 });
    expect(stdout).toContain("all expectations hold");
  },
);
