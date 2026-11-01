import { createLauncher, type Launcher } from "../../src/proc/launch";

// What these cases launch leaves its process group with setsid, which only
// python reaches portably: macOS has no setsid command.
const python = (code: string) => ({ bin: "python3", args: ["-c", code] });

const SET = "import os,sys,time\n";
// Forks a process that leaves the group and holds the inherited stdout for 3 s.
const FORK_HOLDER =
  "if os.fork()==0:\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\n";

let ending: AbortController;
let launcher: Launcher;
beforeEach(() => {
  ending = new AbortController();
  launcher = createLauncher({ signal: ending.signal });
});
afterEach(() => ending.abort());

const launch = (run: { bin: string; args: string[] }, timeoutMs?: number) =>
  launcher.launch({
    category: "user-shell",
    bin: run.bin,
    args: run.args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe("a launch whose child ends with a descendant outside its group", () => {
  it.each([[undefined], [2000]])(
    "resolves on the child's exit code (timeoutMs %s)",
    async (timeoutMs) => {
      const t0 = Date.now();
      const r = await launch(
        python(`${SET}print('out',flush=True)\n${FORK_HOLDER}os._exit(0)\n`),
        timeoutMs,
      );
      expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: "out\n" });
      expect(Date.now() - t0).toBeLessThan(2000);
    },
  );

  it("reports a non-zero exit as one", async () => {
    const r = await launch(python(`${SET}${FORK_HOLDER}os._exit(3)\n`));
    expect(r).toMatchObject({ ok: false, reason: "non-zero", exitCode: 3 });
  });

  it("resolves timeout for a child that ignores SIGTERM", async () => {
    const r = await launch(
      python(
        `${SET}import signal\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\n${FORK_HOLDER}time.sleep(10)\n`,
      ),
      200,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("resolves when a group member ends just after the child", async () => {
    for (let i = 0; i < 50; i += 1) {
      const r = await launch({
        bin: "sh",
        args: [
          "-c",
          'sleep 0.002 & python3 -c "$1"; exit 0',
          "sh",
          `${SET}${FORK_HOLDER}`,
        ],
      });
      expect(r.ok).toBe(true);
    }
  }, 60_000);

  it("is bounded by its timeout when a zombie keeps the group from ending", async () => {
    // A member forks a child it never reaps, then leaves the group holding
    // stdout: the zombie stays a member of the group for the holder's life.
    const t0 = Date.now();
    const r = await launch(
      python(
        `${SET}if os.fork()==0:\n  if os.fork()==0:\n    os._exit(0)\n  os.setsid()\n  time.sleep(3)\n  os._exit(0)\nos._exit(0)\n`,
      ),
      300,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe("a launch whose group outlives its child", () => {
  it("waits for a member holding stdout, and signals it on timeout", async () => {
    const t0 = Date.now();
    const r = await launch(
      { bin: "sh", args: ["-c", "sleep 5 & exit 0"] },
      200,
    );
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
  });

  it("reads what a member wrote just before the group ended", async () => {
    // The block spans the member's end, so its write and the group's end are
    // seen together: a release in that same callback loses the bytes.
    const block = setInterval(() => {
      const until = Date.now() + 150;
      while (Date.now() < until);
    }, 30);
    try {
      for (let i = 0; i < 50; i += 1) {
        const r = await launch({
          bin: "sh",
          args: ["-c", "(sleep 0.03; head -c 60000 /dev/zero) & exit 0"],
        });
        expect(r.stdout.length).toBe(60000);
      }
    } finally {
      clearInterval(block);
    }
  }, 120_000);

  it("polls nothing once `close` has settled it", async () => {
    const r = await launch({
      bin: "sh",
      args: ["-c", "exec >&- 2>&-; sleep 0.5 & sleep 0.1; exit 0"],
    });
    expect(r.ok).toBe(true);
    const spy = jest.spyOn(process, "kill");
    await new Promise((end) => setTimeout(end, 150));
    const probes = spy.mock.calls.filter(([, sig]) => sig === 0);
    spy.mockRestore();
    expect(probes).toEqual([]);
  });
});

it("a child that ends alone loses nothing it wrote", async () => {
  for (let i = 0; i < 30; i += 1) {
    const r = await launch({
      bin: "head",
      args: ["-c", "1048576", "/dev/zero"],
    });
    expect(r.stdout.length).toBe(1048576);
  }
}, 60_000);
