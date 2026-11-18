// [LAW:verifiable-goals] `cc-candybar doctor`'s contract, read off the plan
// the argv binding performs, with no daemon anywhere: the command is the host
// of a bar of its own, its renderer judges the run, and what it prints is the
// report its turn's record notes. The machine is a fake edge, so what each
// case is about is the only fact that moves.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostOf } from "./helpers/host";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import {
  HEALTHY_INSTALL_EDGE,
  HEALTHY_PROCESS,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
  noUrlHandlerEdge,
} from "./helpers/doctor-facts";
import type { World } from "../src/host";
import { systemTimekeeper } from "../src/time";
import {
  doctorPlan,
  parseDoctorArgs,
  reportLine,
  type DoctorPlanInputs,
} from "../src/doctor/cli";
import { notJudged } from "../src/doctor/checks";
import type { DoctorMachineEdge } from "../src/doctor/ports";
import { mainRendererOf } from "../src/renderer/main";
import type { RendererBuilder } from "../src/daemon/local-bar";
import {
  rendererOf,
  type TurnRecord,
} from "../src/renderer-interface/interface";
import { DOCTOR_NOTE } from "../src/renderer-interface/noted-doctor";
import { notedReportsOf } from "./helpers/doctor-note";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-cli-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The machine a healthy setup reads as: one daemon process, no post-mortem,
// a platform with no URL handler, Ghostty outside tmux, the checkout's gh
// logged in.
const healthyEdge = (): DoctorMachineEdge => ({
  install: HEALTHY_INSTALL_EDGE,
  ...healthyDaemonEdge(),
  ...healthyDataEdge(),
  ...noManagedSettings(),
  ...noUrlHandlerEdge(),
  probeTmux: async () => {
    throw new Error("probeTmux must not run outside tmux");
  },
  remoteLogin: async () => {
    throw new Error("remoteLogin must not run outside tmux");
  },
  fontInUse: async () => {
    throw new Error("fontInUse must not run for the bundled default");
  },
});

// The command's world: a home, state, cache and Claude Code directory of the
// case's own, Ghostty's terminal, and a launcher that runs nothing, so the
// bar's own sources fail loudly rather than reach the machine.
const worldIn = (env: Record<string, string> = {}): World => ({
  host: hostOf(
    {
      HOME: dir,
      XDG_CONFIG_HOME: path.join(dir, "config"),
      XDG_STATE_HOME: path.join(dir, "state"),
      XDG_CACHE_HOME: path.join(dir, "cache"),
      CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
      CC_CANDYBAR_SOCKET: path.join(dir, "no-daemon.sock"),
      TERM_PROGRAM: "ghostty",
      TERM_PROGRAM_VERSION: "1.3.1",
      ...env,
    },
    { home: dir, tmp: dir },
  ),
  launcher: unscriptedLauncher,
  clock: systemTimekeeper,
});

// The main renderer, with every turn's record it answers kept.
const recording =
  (records: TurnRecord[]): RendererBuilder =>
  (inputs, host) => {
    const renderer = mainRendererOf(inputs, host);
    return rendererOf({
      event: async (input) => {
        const output = await renderer.answer(input);
        records.push(output.record);
        return output;
      },
      adapter: (input) => renderer.answer(input),
    });
  };

const plan = (inputs: Partial<DoctorPlanInputs> = {}) =>
  doctorPlan({
    world: worldIn(),
    cwd: dir,
    configFile: undefined,
    measureTerminal: () => ({ columns: 120 }),
    edge: healthyEdge,
    ...inputs,
  });

describe("doctorPlan with no daemon", () => {
  test("a healthy machine is exit 0, and each fact only a running daemon holds is ok with a note saying so", async () => {
    const out = await plan();
    expect(out).toEqual({
      stdout:
        "✓ config — bundled default (no config file loaded)\n" +
        `✓ install — ${notJudged("which client draws the bar")}\n` +
        `✓ daemon — ${notJudged("the daemon's memory")}\n` +
        `✓ git environment — ${notJudged("which variables the daemon's git reads run without")}\n` +
        "✓ URL handler\n" +
        "✓ links\n" +
        "✓ tmux truecolor\n" +
        "✓ UTF-8\n" +
        "✓ terminal width — 120 columns, as this command's terminal measured\n" +
        "✓ effect refresh\n" +
        "✓ Nerd Font\n" +
        `✓ segment data — ${notJudged("whether Claude Code sends rate_limits (read by block, weekly)")}\n` +
        `✓ session data — ${notJudged("which transcript the bar reads")}\n`,
      stderr: "",
      code: 0,
    });
  });

  test("the lines printed are the reports the renderer's turn noted", async () => {
    const records: TurnRecord[] = [];
    const out = await plan({ build: recording(records) });
    const noted = records
      .flatMap((record) => record)
      .filter(([key]) => key === DOCTOR_NOTE);
    expect(noted).toHaveLength(1);
    expect(notedReportsOf(noted[0]![1]).map(reportLine).join("")).toBe(
      out.stdout,
    );
  });

  test("a config that does not load fails the config check with the renderer's load message, exit 1", async () => {
    const broken = path.join(dir, "broken.json5");
    fs.writeFileSync(broken, `{ root: [ "nope" , }`);
    const out = await plan({ configFile: broken });
    expect(out.code).toBe(1);
    expect(out.stdout.split("\n")[0]).toBe(
      `✗ config — ${broken} (command argument): Invalid config in ${broken} (1 issue):`,
    );
    expect(out.stdout).toContain("JSON5 syntax error");
  });

  test("a URL handler registered to the forwarder is ok, saying a clicked link's delivery is not judged here", async () => {
    const app = path.join(dir, "CC Candybar.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "CC Candybar"), "");
    const out = await plan({
      edge: () => ({
        ...healthyEdge(),
        handler: async () => ({
          kind: "read",
          opener: { kind: "ok", value: { app, forwarder: true } },
        }),
      }),
    });
    expect(out.stdout).toContain(
      `✓ URL handler — the forwarder app opens cc-candybar://; ${notJudged("whether a clicked link reaches the daemon")}\n`,
    );
  });

  test("two daemons running at once fail the daemon check from the process table alone", async () => {
    const out = await plan({
      edge: () => ({
        ...healthyEdge(),
        daemons: async () => ({
          kind: "ok",
          value: [HEALTHY_PROCESS, { ...HEALTHY_PROCESS, pid: 4200 }],
        }),
      }),
    });
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/\n✗ daemon — 2 daemons run at once/);
  });

  test("a terminal that measures no width fails the width check for this command's own terminal, naming no daemon", async () => {
    const out = await plan({ measureTerminal: () => ({}) });
    expect(out.code).toBe(1);
    expect(out.stdout).toContain(
      "\n✗ terminal width — this command's terminal measured no width (no COLUMNS, and no terminal to ask), so the bar is laid out as if the terminal were 120 columns wide\n",
    );
  });

  test("a run whose reading never comes is exit 2, saying so, and prints no checks", async () => {
    const out = await plan({
      reportMs: 50,
      edge: () => ({
        ...healthyEdge(),
        daemons: () => new Promise(() => {}),
      }),
    });
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(/^doctor: no report within 0\.05s/);
  });

  test("a run whose reading failed is exit 2 with the reason, not a wait for a report", async () => {
    const out = await plan({
      edge: () => ({
        ...healthyEdge(),
        daemons: async () => {
          throw new Error("the process table would not read");
        },
      }),
    });
    expect(out.code).toBe(2);
    expect(out.stdout).toBe("");
    expect(out.stderr).toMatch(
      /^doctor: the doctor's run failed: .*the process table would not read/,
    );
  });

  test("a terminal release with a space in it is noted whole, and the run reports", async () => {
    const records: TurnRecord[] = [];
    const out = await plan({
      world: worldIn({ TERM_PROGRAM_VERSION: "1.3 beta" }),
      build: recording(records),
    });
    expect(out.code).toBe(0);
    const terminal = records
      .flatMap((record) => record)
      .filter(([key]) => key === "terminal");
    expect(terminal).toEqual([["terminal", "ghostty@1.3 beta"]]);
  });

  test("an error the bar logged on a run that reported is the command's failure, said beside the report", async () => {
    const out = await plan({
      build: (inputs, host) => {
        const renderer = mainRendererOf(inputs, host);
        return rendererOf({
          event: async (input) => {
            if (input.event.kind === "effect-done")
              throw new Error("the outcome would not land");
            return renderer.answer(input);
          },
          adapter: (input) => renderer.answer(input),
        });
      },
    });
    expect(out.stdout).toMatch(/^✓ config/);
    expect(out.stderr).toMatch(/^doctor: .*the outcome would not land/);
    expect(out.code).toBe(2);
  });

  test("a close that fails is the command's failure, said after the report, and the rest still close", async () => {
    const out = await plan({
      build: (inputs, host) => {
        const renderer = mainRendererOf(inputs, host);
        return rendererOf({
          event: (input) => renderer.answer(input),
          adapter: (input) => {
            if (input.push.kind === "close-journal")
              throw new Error("the journal would not close");
            return renderer.answer(input);
          },
        });
      },
    });
    expect(out.code).toBe(2);
    expect(out.stdout).toMatch(/^✓ config/);
    expect(out.stderr).toMatch(
      /^doctor: bar close failed: .*the journal would not close/,
    );
  });
});

// A regression names its row: reintroducing `args[0] === ""` shows the `[""]`
// row as usage where run is expected.
test("parseDoctorArgs refuses two files or an option, never an empty name", () => {
  const USAGE = "Usage: cc-candybar doctor [config-file]\n";
  const ARITY = `doctor: expected at most one config file\n${USAGE}`;
  const table = [
    [],
    [""],
    ["a.json5"],
    ["a.json5", "b.json5"],
    ["--help"],
    ["a.json5", "--verbose"],
  ];
  expect(
    table.map((args) => ({ args, parsed: parseDoctorArgs(args) })),
  ).toEqual([
    { args: [], parsed: { kind: "run", configFile: undefined } },
    { args: [""], parsed: { kind: "run", configFile: "" } },
    { args: ["a.json5"], parsed: { kind: "run", configFile: "a.json5" } },
    {
      args: ["a.json5", "b.json5"],
      parsed: { kind: "usage", message: ARITY },
    },
    {
      args: ["--help"],
      parsed: {
        kind: "usage",
        message: `doctor: unknown option --help\n${USAGE}`,
      },
    },
    {
      args: ["a.json5", "--verbose"],
      parsed: {
        kind: "usage",
        message: `doctor: unknown option --verbose\n${USAGE}`,
      },
    },
  ]);
});
