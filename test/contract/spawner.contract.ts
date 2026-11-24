import type { Behaviour } from "../../src/proc/spawner-fake";
import type { SpawnedChild, Spawner } from "../../src/proc/spawner";

// A program a subject can start: what to hand `spawn`.
export interface Program {
  readonly bin: string;
  readonly args: readonly string[];
}

// What a test of a Spawner needs from its subject. Behaviours are stated as
// data; the real spawner realises each as a `/bin/sh` script, the fake as a
// registration, so one set of cases runs on both. `settle` moves time: the fake
// advances its clock, the real one waits.
export interface Subject {
  readonly spawner: Spawner;
  readonly realise: (behaviour: Behaviour) => Program;
  // A program that does not exist on the subject's machine.
  readonly missing: Program;
  readonly settle: (ms: number) => Promise<void>;
}

interface Watched {
  readonly child: SpawnedChild;
  stdout: string;
  stderr: string;
  // In arrival order: `data`, `exit`, `close`, `error`.
  readonly events: string[];
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  error: (Error & { code?: string }) | null;
}

// [LAW:one-source-of-truth] What a Spawner promises, stated once. The fake
// (test/unit/spawner-fake.test.ts) and the real one
// (test/integration/system-spawner.test.ts) both run it, so a launch decision
// that a unit test proves over the fake holds over a real child too. Real time
// forbids exact figures: a case asserts an order or an outcome, never a duration.
export function spawnerContract(name: string, make: () => Subject): void {
  describe(`${name} is a Spawner`, () => {
    const started: SpawnedChild[] = [];
    afterEach(() => {
      // A hung child is ended by its group, as a launch ends it.
      for (const child of started.splice(0)) {
        if (child.pid !== undefined) subject?.spawner.signalGroup(child.pid, "SIGKILL");
      }
    });
    let subject: Subject | undefined;

    function begin(behaviour: Behaviour): Watched {
      subject = make();
      return start(subject, subject.realise(behaviour));
    }

    function start(s: Subject, program: Program): Watched {
      const child = s.spawner.spawn(program.bin, program.args, {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      started.push(child);
      const w: Watched = {
        child,
        stdout: "",
        stderr: "",
        events: [],
        exit: null,
        error: null,
      };
      child.stdout?.on("data", (b: Buffer) => {
        w.stdout += b.toString();
        w.events.push("data");
      });
      child.stderr?.on("data", (b: Buffer) => (w.stderr += b.toString()));
      child.once("exit", (code, signal) => {
        w.exit = { code, signal };
        w.events.push("exit");
      });
      child.once("close", () => w.events.push("close"));
      child.once("error", (e) => {
        w.error = e;
        w.events.push("error");
      });
      return w;
    }

    // Moves time until the condition holds, or fails naming what it waited for.
    async function until(what: string, ok: () => boolean): Promise<void> {
      for (let waited = 0; !ok(); waited += 20) {
        if (waited > 4000) throw new Error(`never happened: ${what}`);
        await subject!.settle(20);
      }
    }

    const hung = (): Behaviour => ({ runsFor: Infinity, exitCode: 0 });

    test("a program that exits reports its code, and its output arrives before its close", async () => {
      const w = begin({ runsFor: 0, exitCode: 3, stdout: "out", stderr: "err" });
      await until("close", () => w.events.includes("close"));
      expect(w.exit).toEqual({ code: 3, signal: null });
      expect(w.child.exitCode).toBe(3);
      expect(w.stdout).toBe("out");
      expect(w.stderr).toBe("err");
      expect(w.events.indexOf("exit")).toBeLessThan(w.events.indexOf("close"));
      expect(w.events.indexOf("data")).toBeLessThan(w.events.indexOf("close"));
    });

    test("a program that runs for a while is still running before that, and exits after", async () => {
      const w = begin({ runsFor: 300, exitCode: 0 });
      await subject!.settle(20);
      expect(w.exit).toBeNull();
      await until("exit", () => w.exit !== null);
      expect(w.exit).toEqual({ code: 0, signal: null });
    });

    test("a signal to the group ends a program that has no answer, and says which", async () => {
      const w = begin(hung());
      await subject!.settle(60);
      expect(w.exit).toBeNull();
      subject!.spawner.signalGroup(w.child.pid!, "SIGTERM");
      await until("exit", () => w.exit !== null);
      expect(w.exit).toEqual({ code: null, signal: "SIGTERM" });
      expect(w.child.signalCode).toBe("SIGTERM");
    });

    test("a program that ignores a signal outlives it, and the next one ends it", async () => {
      const w = begin({ ...hung(), ignores: ["SIGTERM"] });
      await subject!.settle(60);
      subject!.spawner.signalGroup(w.child.pid!, "SIGTERM");
      await subject!.settle(200);
      expect(w.exit).toBeNull();
      subject!.spawner.signalGroup(w.child.pid!, "SIGKILL");
      await until("exit", () => w.exit !== null);
      expect(w.exit).toEqual({ code: null, signal: "SIGKILL" });
    });

    test("a group is not gone while its program runs, and is once it has ended", async () => {
      const w = begin(hung());
      await subject!.settle(60);
      const { spawner } = subject!;
      const pid = w.child.pid!;
      expect(spawner.groupGone(pid)).toBe(false);
      expect(spawner.signalJob(pid, 0)).toBe(true);
      spawner.signalGroup(pid, "SIGKILL");
      await until("the group's end", () => spawner.groupGone(pid));
      expect(spawner.signalJob(pid, 0)).toBe(false);
    });

    test("a signal to a group that never was is no failure, and a job signal says no", () => {
      subject = make();
      expect(() => subject!.spawner.signalGroup(2_000_000_000, "SIGTERM")).not.toThrow();
      expect(subject.spawner.groupGone(2_000_000_000)).toBe(true);
      expect(subject.spawner.signalJob(2_000_000_000, "SIGTERM")).toBe(false);
    });

    test("a program that does not exist has no pid, and says it is missing", async () => {
      subject = make();
      const w = start(subject, subject.missing);
      await until("error", () => w.error !== null);
      expect(w.child.pid).toBeUndefined();
      expect(w.error!.code).toBe("ENOENT");
    });

    test("what is written to a program's stdin reaches it, and its end is seen", async () => {
      const w = begin({ ...hung(), stdin: "echo" });
      w.child.stdin!.end("hello");
      await until("exit", () => w.exit !== null);
      expect(w.stdout).toBe("hello");
      expect(w.exit).toEqual({ code: 0, signal: null });
    });

    test("a program that reads stdin to its end exits with it", async () => {
      const w = begin({ ...hung(), stdin: "until-end" });
      await subject!.settle(60);
      expect(w.exit).toBeNull();
      w.child.stdin!.end();
      await until("exit", () => w.exit !== null);
      expect(w.exit).toEqual({ code: 0, signal: null });
    });

    test("a program that writes a lot delivers every byte", async () => {
      const w = begin({ ...hung(), floods: 200_000 });
      await until("all the bytes", () => w.stdout.length >= 200_000);
      expect(w.stdout.length).toBe(200_000);
    });

    test("a blocking start returns the program's code and output", () => {
      subject = make();
      const p = subject.realise({ runsFor: 0, exitCode: 2, stdout: "o", stderr: "e" });
      const r = subject.spawner.spawnSync(p.bin, p.args, { encoding: "utf8" });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("o");
      expect(r.stderr).toBe("e");
      expect(r.error).toBeUndefined();
    });

    test("a blocking start of a program that does not answer ends at its timeout", () => {
      subject = make();
      const p = subject.realise(hung());
      const r = subject.spawner.spawnSync(p.bin, p.args, {
        encoding: "utf8",
        timeout: 100,
      });
      expect((r.error as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
      expect(r.status).toBeNull();
    });

    test("a blocking start of a program that does not exist says it is missing", () => {
      subject = make();
      const r = subject.spawner.spawnSync(subject.missing.bin, subject.missing.args, {
        encoding: "utf8",
      });
      expect((r.error as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(r.status).toBeNull();
    });
  });
}
