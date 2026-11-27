import { systemTimekeeper } from "../../../scripts/lib/system-clock";

test("a named period is released", () => {
  const cancel = systemTimekeeper.every(
    "fixture stopped feed",
    60000,
    () => {},
  );
  cancel();
});
