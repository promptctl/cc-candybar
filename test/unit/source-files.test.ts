import { SourceFiles } from "../../src/daemon/source-files";

const FILE = "/inputs/status.json";
const OTHER_FILE = "/other/status.json";

test("readers queued for one path share its bytes, and a later refresh reads again", async () => {
  let contents = "before";
  const read: string[] = [];
  const files = new SourceFiles(async (file) => {
    read.push(file);
    return contents;
  });
  const signal = new AbortController().signal;
  const first = files.read(FILE, signal);
  const second = files.read(FILE, signal);
  const other = files.read(OTHER_FILE, signal);
  // Let the filesystem reads take their snapshots; a new caller needs the
  // later contents even if the promises for those snapshots have not settled.
  await Promise.resolve();
  contents = "after";
  const later = files.read(FILE, signal);

  await expect(first).resolves.toEqual({ kind: "text", text: "before" });
  await expect(second).resolves.toEqual({ kind: "text", text: "before" });
  await expect(other).resolves.toEqual({ kind: "text", text: "before" });
  await expect(later).resolves.toEqual({ kind: "text", text: "after" });
  expect(read).toEqual([FILE, OTHER_FILE, FILE]);
});

test("one abandoned reader leaves the shared read alive for the other", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const files = new SourceFiles(async (_file, signal) => {
    first.abort();
    signal.throwIfAborted();
    return "shared";
  });
  const abandoned = files.read(FILE, first.signal);
  const live = files.read(FILE, second.signal);
  await expect(live).resolves.toEqual({ kind: "text", text: "shared" });
  await abandoned;
});

test("requests abandoned before dispatch do not touch disk", async () => {
  let read = false;
  const files = new SourceFiles(async () => {
    read = true;
    return "unused";
  });
  const reader = new AbortController();
  const result = files.read(FILE, reader.signal);
  reader.abort();
  await expect(result).resolves.toMatchObject({ kind: "error" });
  expect(read).toBe(false);
});

test("abandoning the last caller ends an in-flight read", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const files = new SourceFiles(
    (_file, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const before = files.read(FILE, first.signal);
  const after = files.read(FILE, second.signal);
  await Promise.resolve();
  first.abort();
  second.abort();
  await expect(before).resolves.toMatchObject({ kind: "error" });
  await expect(after).resolves.toMatchObject({ kind: "error" });
});
