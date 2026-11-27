import { systemTimekeeper } from "../../../scripts/lib/system-clock";

test("a named period remains armed", () => {
  systemTimekeeper.every("fixture leaked feed", 60000, () => {}, {
    unref: true,
  });
});
