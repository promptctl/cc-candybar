import { KeyedSerialQueue } from "../src/utils/keyed-serial-queue";

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

  test("another key does not wait", async () => {
    const queue = new KeyedSerialQueue<string>();
    const held = gate();
    const a = queue.run("a", () => held.wait);
    await expect(queue.run("b", async () => "free")).resolves.toBe("free");
    held.open();
    await a;
  });
});
