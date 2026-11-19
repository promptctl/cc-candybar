import { Writable } from "node:stream";
import { newestWins } from "../../src/utils/newest-wins.js";

function delayed(highWaterMark = 1) {
  const chunks: string[] = [];
  let complete: ((error?: Error | null) => void) | undefined;
  const out = new Writable({
    highWaterMark,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      complete = callback;
    },
  });
  return {
    out,
    chunks,
    complete(error?: Error) {
      if (complete === undefined)
        throw new Error("no writable chunk to finish");
      const callback = complete;
      complete = undefined;
      callback(error);
    },
  };
}

function receipts() {
  const settled: [string, boolean][] = [];
  return {
    settled,
    for: (name: string) => (delivered: boolean) =>
      settled.push([name, delivered]),
  };
}

const watched = ["drain", "error", "finish", "close"] as const;

test.each([1, 64])(
  "reports only the written frames once with highWaterMark %i",
  (mark) => {
    const stream = delayed(mark);
    const emit = newestWins(stream.out);
    const result = receipts();
    expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
      0, 0, 0, 0,
    ]);

    emit("first", result.for("first"));
    emit("middle", result.for("middle"));
    emit(Buffer.from("last"), result.for("last"));
    expect(stream.chunks).toEqual(["first"]);
    expect(result.settled).toEqual([["middle", false]]);
    expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
      1, 1, 1, 1,
    ]);

    stream.complete();
    expect(stream.chunks).toEqual(["first", "last"]);
    expect(result.settled).toEqual([
      ["middle", false],
      ["first", true],
    ]);
    stream.complete();
    expect(result.settled).toEqual([
      ["middle", false],
      ["first", true],
      ["last", true],
    ]);
    expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
      0, 0, 0, 0,
    ]);
  },
);

test("calls without receipts write until the stream asks for backpressure", () => {
  const stream = delayed(12);
  const emit = newestWins(stream.out);
  emit("first");
  emit("second");
  emit("third");
  emit("superseded");
  emit("latest");

  stream.complete();
  stream.complete();
  stream.complete();
  stream.complete();
  expect(stream.chunks).toEqual(["first", "second", "third", "latest"]);
  expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
    0, 0, 0, 0,
  ]);
});

test("close settles active, buffered and later writes once", async () => {
  const stream = delayed();
  const emit = newestWins(stream.out);
  const result = receipts();
  emit("active", result.for("active"));
  emit("buffered", result.for("buffered"));

  const closed = new Promise<void>((resolve) =>
    stream.out.once("close", resolve),
  );
  stream.out.destroy();
  await closed;
  stream.complete();
  emit("later", result.for("later"));
  expect(stream.chunks).toEqual(["active"]);
  expect(result.settled).toEqual([
    ["active", false],
    ["buffered", false],
    ["later", false],
  ]);
  expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
    0, 0, 0, 0,
  ]);
});

test("an erroring write settles both receipts and releases the listeners", async () => {
  const stream = delayed();
  const emit = newestWins(stream.out);
  const result = receipts();
  emit("active", result.for("active"));
  emit("buffered", result.for("buffered"));

  const closed = new Promise<void>((resolve) =>
    stream.out.once("close", resolve),
  );
  stream.complete(new Error("broken pipe"));
  await closed;
  expect(stream.chunks).toEqual(["active"]);
  expect(result.settled).toEqual([
    ["active", false],
    ["buffered", false],
  ]);
  expect(watched.map((event) => stream.out.listenerCount(event))).toEqual([
    0, 0, 0, 0,
  ]);
});
