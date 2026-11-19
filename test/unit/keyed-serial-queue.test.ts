import { FOREGROUND_BURST, KeyedSerialQueue } from "../../src/utils/keyed-serial-queue";

function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

describe("KeyedSerialQueue", () => {
  test("a key's tasks run first in, first out, each returning its own result", async () => {
    const queue = new KeyedSerialQueue<string>();
    const first = gate();
    const ran: string[] = [];
    const a = queue.run("k", async () => {
      ran.push("a");
      await first.wait;
      return 1;
    });
    const b = queue.run("k", async () => {
      ran.push("b");
      return "two";
    });
    expect(ran).toEqual(["a"]);
    first.open();
    await expect(a).resolves.toBe(1);
    await expect(b).resolves.toBe("two");
    expect(ran).toEqual(["a", "b"]);
  });

  test("a rejection reaches its caller, and the task behind it still runs", async () => {
    const queue = new KeyedSerialQueue<string>();
    const a = queue.run("k", async () => {
      throw new Error("no");
    });
    const b = queue.run("k", async () => "after");
    await expect(a).rejects.toThrow("no");
    await expect(b).resolves.toBe("after");
  });

  test("scheduled work behind a short burst leaves ordinary work in order", async () => {
    const queue = new KeyedSerialQueue<string>();
    const held = gate();
    const ran: string[] = [];
    const task = (name: string) => async (): Promise<void> => {
      ran.push(name);
    };
    const running = queue.run("k", () => held.wait);
    const scheduled = queue.run("k", task("scheduled"), "scheduled");
    const last = queue.run("k", task("last"));
    const first = queue.run("k", task("first"), "first");
    held.open();
    await Promise.all([running, scheduled, last, first]);
    expect(ran).toEqual(["first", "last", "scheduled"]);
  });

  test("one scheduled slot runs after a burst even while each ordinary slot replenishes the queue", async () => {
    const queue = new KeyedSerialQueue<string>();
    const held = gate();
    const running = queue.run("k", () => held.wait);
    const turns: Array<number | string> = [];
    const finished = gate();
    const submit = (i: number): Promise<void> => queue.run("k", async () => {
      turns.push(i);
      if (i < FOREGROUND_BURST * 3) void submit(i + 1);
      else finished.open();
    });
    const first = submit(1);
    const due = (name: string): Promise<void> => queue.run("k", async () => {
      turns.push(name);
    }, "scheduled");
    const a = due("a");
    const b = due("b");
    held.open();
    await Promise.all([running, first, a, b, finished.wait]);
    expect(turns.indexOf("a")).toBe(FOREGROUND_BURST);
    expect(turns.indexOf("b")).toBe(2 * FOREGROUND_BURST + 1);
    expect(turns.filter((turn) => typeof turn === "number")).toEqual(
      Array.from({ length: 3 * FOREGROUND_BURST }, (_, i) => i + 1),
    );
  });

  test("another key does not wait", async () => {
    const queue = new KeyedSerialQueue<string>();
    const held = gate();
    const a = queue.run("a", () => held.wait);
    await expect(queue.run("b", async () => "free")).resolves.toBe("free");
    held.open();
    await a;
  });
});
