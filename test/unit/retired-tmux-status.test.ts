import {
  BINDING_OPTION,
  PRIOR_OPTION,
  RetiredTmuxStatus,
  WROTE_OPTION,
  rowOption,
  type Prior,
} from "../../src/daemon/retired-tmux-status";
import type { Monotonic } from "../../src/time";
import type { TmuxRun } from "../../src/proc/tmux";

const SOCKET = "/tmp/test-tmux";
const HOST = "/tmp/test-candybar/socket";
const PREVIOUS = "bind-key -T root MouseDown1Status select-window -t =";
const RETIRED = `bind-key  -T root MouseDown1Status          if-shell -F "#{m:ccb*,#{mouse_status_range}}" "run-shell -b cc-candybar://tmux-status-click/${encodeURIComponent(SOCKET)}/#{s/%//:pane_id}/#{q:mouse_status_range}"`;
const ROW = `#[fill=terminal]#{${rowOption(0)}}`;
const PRIOR: Prior = {
  owner: HOST,
  base: 1,
  status: "on",
  formats: { 0: "the old option" },
  wrote: { 0: "the old option", 1: ROW },
};

function rig({
  layout = JSON.stringify(PRIOR),
  owner = HOST,
  binding = RETIRED,
  current = "the old option",
  height = "2",
}: {
  readonly layout?: string;
  readonly owner?: string;
  readonly binding?: string;
  readonly current?: string;
  readonly height?: string;
} = {}) {
  const commands: Array<{ args: readonly string[]; stdin?: string }> = [];
  const mutations = () =>
    commands.filter(({ args }) =>
      ["set-option", "source-file", "unbind-key"].includes(args[0]!),
    );
  const log: string[] = [];
  let now = 0;
  let nextFailure: string | null = null;
  const migration = new RetiredTmuxStatus(
    HOST,
    async (socket, args, stdin): Promise<TmuxRun> => {
      expect(socket).toBe(SOCKET);
      commands.push({ args, stdin });
      if (nextFailure !== null) {
        const reason = nextFailure;
        nextFailure = null;
        return { kind: "failed", reason };
      }
      switch (args[0]) {
        case "list-sessions":
          return { kind: "ok", stdout: `$0\t${layout}\n` };
        case "show-options":
          if (args.includes(BINDING_OPTION))
            return {
              kind: "ok",
              stdout: JSON.stringify({ owner, prior: { line: PREVIOUS } }),
            };
          return {
            kind: "ok",
            stdout: [
              `status ${height}\nstatus-format[0] ${current}\nstatus-format[1] ${ROW}`,
              height,
              current,
              ROW,
              "",
              "",
              "",
              "2",
            ]
              .map((part) => (part === "" ? "" : `${part}\n`))
              .join("ccb:separator\n"),
          };
        case "list-keys":
          return { kind: "ok", stdout: `${binding}\n` };
        default:
          return { kind: "ok", stdout: "" };
      }
    },
    { monotonic: () => now as Monotonic },
    (level, line) => log.push(`${level}: ${line}`),
  );
  return {
    migration,
    commands,
    mutations,
    log,
    transientFailure: () => {
      nextFailure = "tmux was unavailable";
    },
    at: (ms: number) => {
      now = ms;
    },
  };
}

test("restores the daemon's old layout and binding once for a server", async () => {
  const { migration, commands, mutations } = rig();
  await Promise.all([migration.observe(SOCKET), migration.observe(SOCKET)]);
  await migration.observe(SOCKET);
  expect(
    commands.filter(({ args }) => args[0] === "list-sessions"),
  ).toHaveLength(1);
  const [layout, rebind, forget] = mutations();
  expect(layout?.args).toEqual(
    expect.arrayContaining([
      "status-format",
      "the old option",
      "on",
      PRIOR_OPTION,
      WROTE_OPTION,
      rowOption(0),
    ]),
  );
  expect(rebind).toEqual({
    args: ["source-file", "-"],
    stdin: `${PREVIOUS}\n`,
  });
  expect(forget?.args).toEqual([
    "set-option",
    "-g",
    "-q",
    "-u",
    BINDING_OPTION,
  ]);
});

test("preserves changed options and a changed binding, removing only old rows and markers", async () => {
  const { migration, mutations } = rig({
    current: "user's new format",
    height: "5",
    binding: `bind-key -T root MouseDown1Status display-message "see cc-candybar://tmux-status-click/example"`,
  });
  await migration.observe(SOCKET);
  const [layout, forget] = mutations();
  expect(layout?.args).toEqual(
    expect.arrayContaining([
      "status-format[1]",
      rowOption(0),
      PRIOR_OPTION,
      WROTE_OPTION,
    ]),
  );
  expect(layout?.args).not.toContain("status-format[0]");
  expect(layout?.args).not.toContain("status");
  expect(forget?.args).toEqual([
    "set-option",
    "-g",
    "-q",
    "-u",
    BINDING_OPTION,
  ]);
  expect(mutations()).toHaveLength(2);
});

test.each([
  ["a foreign owner", { owner: "another socket" }],
  ["an out-of-range base", { base: 6 }],
  ["an invalid previous status", { status: "unknown" }],
  ["an array where sparse formats belong", { formats: [] }],
  ["an invalid row index", { wrote: { 5: "unexpected" } }],
  ["a non-text format", { wrote: { 1: 1 } }],
])("leaves %s alone", async (_, change) => {
  const { migration, mutations } = rig({
    layout: JSON.stringify({ ...PRIOR, ...change }),
    owner: "another socket",
  });
  await migration.observe(SOCKET);
  expect(mutations()).toEqual([]);
});

test("a transient read failure retries at most once a minute", async () => {
  const { migration, commands, transientFailure, at, log } = rig();
  transientFailure();
  await migration.observe(SOCKET);
  await migration.observe(SOCKET);
  expect(commands).toHaveLength(1);
  expect(log).toEqual([expect.stringContaining("tmux was unavailable")]);
  at(60_000);
  await migration.observe(SOCKET);
  expect(
    commands.filter(({ args }) => args[0] === "list-sessions"),
  ).toHaveLength(2);
});
