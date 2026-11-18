// [LAW:single-enforcer] The host's one reader of the doctor's facts, as each
// host hands it what it saw of a session's bars: the daemon its render
// sightings and itself, `cc-candybar doctor` the one bar it drew and nothing a
// running daemon alone holds. The read is the same code either way; only the
// provider moves.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DoctorSource,
  daemonSighted,
  type DoctorReadInput,
} from "../src/daemon/cache/doctor";
import { doctorAsk, type DoctorReading } from "../src/doctor/gather";
import { NOT_HELD, held } from "../src/doctor/checks";
import { installFacts } from "../src/doctor/edge";
import type { DoctorMachineEdge } from "../src/doctor/ports";
import type { Sighted } from "../src/doctor/read";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import type { RenderSighting } from "../src/daemon/foundations/sightings";
import { Holds } from "../src/utils/holds";
import { RefreshLedger } from "../src/utils/refresh-ledger";
import type { Outcome } from "../src/utils/outcome";
import { systemTimekeeper } from "../src/time";
import {
  HEALTHY_BUNDLE,
  HEALTHY_INSTALL_EDGE,
  HEALTHY_SERVING,
  HEALTHY_REPO_VARIABLES,
  healthyClient,
  healthyDaemonEdge,
  healthyDataEdge,
  noManagedSettings,
  renderSaid,
} from "./helpers/doctor-facts";

const SESSION = sessionIdOf("doctor-source");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-doctor-source-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The machine, with how often its URL handler registration was asked.
const machine = () => {
  const asked = { handler: 0 };
  const edge: DoctorMachineEdge = {
    install: HEALTHY_INSTALL_EDGE,
    ...healthyDaemonEdge(),
    ...healthyDataEdge(),
    ...noManagedSettings(),
    handler: async () => {
      asked.handler++;
      return { kind: "unsupported" };
    },
    probeTmux: async () => {
      throw new Error("probeTmux must not run outside tmux");
    },
    remoteLogin: async () => {
      throw new Error("remoteLogin must not run outside tmux");
    },
    fontInUse: async () => {
      throw new Error("fontInUse must not run for an unreported terminal");
    },
  };
  return { edge, asked };
};

// A run of the bundled default, asked as `arrival` came.
const input = (
  arrival: DoctorReadInput["ask"]["arrival"],
): DoctorReadInput => ({
  session: SESSION,
  hints: { tmux: null, ssh: false, claudeConfigDir: dir },
  origin: { cwd: dir, projectDir: dir },
  ask: doctorAsk(
    1,
    {
      layers: [],
      error: null,
      warnings: [],
      repo: null,
      unused: [],
      config: DEFAULT_DSL_CONFIG,
    },
    () => null,
    arrival,
  ),
});

// One read through the source, as the collector declares it, to its outcome.
async function read(
  sighted: (session: typeof SESSION) => Sighted,
  edge: DoctorMachineEdge,
  ask: DoctorReadInput,
): Promise<Outcome<DoctorReading>> {
  const source = new DoctorSource({
    edge: () => edge,
    sighted,
    clock: systemTimekeeper,
    logger: () => {},
    ledger: new RefreshLedger(() => {}),
  });
  const holds = new Holds();
  try {
    const lane = holds.declare(() => source.declare(holds, ask)).result;
    const first = lane.current();
    if ("landed" in first) await first.landed;
    const landed = lane.current();
    if ("landed" in landed) throw new Error("the read did not land");
    return landed;
  } finally {
    holds.close();
    source.close();
  }
}

const reading = (outcome: Outcome<DoctorReading>) => {
  if (outcome.kind !== "ok" || outcome.value.kind !== "read")
    throw new Error(`no reading: ${JSON.stringify(outcome)}`);
  return outcome.value;
};

test("a command's provider: its own bar and width are judged, the facts only a daemon holds are not held, and the URL handler's registration is read", async () => {
  const { edge, asked } = machine();
  const bar = {
    role: "statusline",
    frame: "still",
    projectDir: dir,
    claudeConfigDir: dir,
  } as const;
  const got = reading(
    await read(
      () => ({
        serving: NOT_HELD,
        repoVariables: NOT_HELD,
        rateLimits: NOT_HELD,
        transcripts: NOT_HELD,
        clients: NOT_HELD,
        bars: [bar],
        width: { kind: "ok", value: { columns: 90, of: { kind: "command" } } },
      }),
      edge,
      input({ via: "command" }),
    ),
  );
  expect(got.install).toEqual(NOT_HELD);
  expect(got.machine.daemon.serving).toEqual(NOT_HELD);
  expect(got.machine.transcripts).toEqual(NOT_HELD);
  expect(got.machine.data.rateLimits).toMatchObject({
    kind: "needed",
    fact: NOT_HELD,
  });
  // The bar read at the run's own chain, judged by what it drew.
  expect(got.machine.claudeSettings.origin.bars).toEqual([
    { role: "statusline", frame: "still" },
  ]);
  expect(got.machine.width).toEqual({
    kind: "ok",
    value: { columns: 90, of: { kind: "command" } },
  });
  expect(got.machine.urlHandler).toEqual({ kind: "unsupported" });
  expect(asked.handler).toBe(1);
});

test("the daemon's provider: its sightings and itself are held, and a link's arrival asks the machine nothing of the handler", async () => {
  const { edge, asked } = machine();
  const said: RenderSighting = {
    ...renderSaid(healthyClient(), { projectDir: dir, claudeConfigDir: dir }),
    role: "statusline",
    sessionId: SESSION,
    ago: 1,
  };
  const got = reading(
    await read(
      (session) =>
        daemonSighted(
          session,
          [said],
          HEALTHY_SERVING,
          HEALTHY_BUNDLE,
          HEALTHY_REPO_VARIABLES,
        ),
      edge,
      input({ via: "link", delivery: { kind: "forwarder", urlV: 1 } }),
    ),
  );
  expect(got.install).toEqual(
    held(installFacts(HEALTHY_INSTALL_EDGE, HEALTHY_BUNDLE, [healthyClient()])),
  );
  expect(got.machine.daemon.serving).toEqual(held(HEALTHY_SERVING));
  expect(got.machine.data.rateLimits).toMatchObject({
    kind: "needed",
    fact: held(["carried"]),
  });
  expect(got.machine.width).toEqual({
    kind: "ok",
    value: { columns: 148, of: { kind: "session", sessionId: SESSION } },
  });
  expect(got.machine.urlHandler).toEqual({
    kind: "arrived",
    delivery: { kind: "forwarder", urlV: 1 },
  });
  expect(asked.handler).toBe(0);
});

test("a provider that throws is the run's failed reading, with its message", async () => {
  const { edge } = machine();
  const outcome = await read(
    () => {
      throw new Error("the doctor's read came before its bar was drawn");
    },
    edge,
    input({ via: "command" }),
  );
  // The lane holds the read's failure; the host's lane names its run.
  expect(outcome).toEqual({
    kind: "failed",
    reason: "the doctor's read came before its bar was drawn",
    failedAt: "read",
  });
});
