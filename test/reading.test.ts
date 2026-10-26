import { reaction } from "mobx";
import { failed, ok } from "../src/utils/outcome";
import { renew, settle, unread, type Readable } from "../src/utils/reading";

// brandon-unfiled-3248.8ro6 §4e: a stored value moves only when a read finds
// something else, by structure, so a refresh that found the same branch or
// pane name recomputes nothing over it and wakes no feed showing it.
test("a read that found what is stored, by structure, moves nothing derived from it", async () => {
  const source: Readable<{ branch: string; ahead: number }> = {
    reading: unread(),
  };
  const moves: string[] = [];
  const stop = reaction(
    () => source.reading.get(),
    (reading) => moves.push(reading.kind),
  );
  const first = source.reading.get();
  settle(source, ok({ branch: "main", ahead: 1 }));
  // A pending value lands, and its waiter is answered.
  expect(first.kind).toBe("pending");
  if (first.kind === "pending") await first.landed;
  // A new object, equal by structure.
  settle(source, ok({ branch: "main", ahead: 1 }));
  expect(moves).toEqual(["read"]);
  settle(source, ok({ branch: "main", ahead: 2 }));
  settle(source, failed("git exited 128"));
  settle(source, failed("git exited 128"));
  expect(moves).toEqual(["read", "read", "read"]);
  // A renewed value is pending, and the read after it lands even when it
  // found what was stored before.
  renew(source, "unread");
  settle(source, failed("git exited 128"));
  expect(moves).toEqual(["read", "read", "read", "pending", "read"]);
  stop();
});
