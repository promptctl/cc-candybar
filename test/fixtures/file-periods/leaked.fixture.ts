import { setInterval as nativeInterval } from "node:timers";
import { systemTimekeeper } from "../../../scripts/lib/system-clock";

test("a named period remains armed", () => {
  systemTimekeeper.every("fixture leaked feed", 60000, () => {}, {
    unref: true,
  });
});

test("a period armed through the timers module belongs to this file too", () => {
  nativeInterval(function modulePeriod() {}, 60000).unref();
});
