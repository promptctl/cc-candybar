import { systemTimekeeper } from "../../../scripts/lib/system-clock";

test("a named period is released", () => {
  const cancel = systemTimekeeper.every(
    "fixture stopped feed",
    60000,
    () => {},
  );
  cancel();
});

test("a disposed timer has ended", () => {
  const handle = setInterval(function disposed() {}, 60000);
  handle[Symbol.dispose]();
});
