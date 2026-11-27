import type { Timekeeper } from "../../src/time";
import {
  fakeLauncher,
  turns,
} from "../../scripts/lib/draw-fixtures/fake-launcher";
import { systemTimekeeper } from "../../scripts/lib/system-clock";

// A test that supplies its own controller can use fakeLauncher directly.
// A file-owned scripted OS reaps its children on that OS's own clock.
export function fixtureFakeLauncher(
  clock: Timekeeper,
  inherited: NodeJS.ProcessEnv,
) {
  const owner = new AbortController();
  const fixture = fakeLauncher(clock, { inherited, signal: owner.signal });
  const close = async () => {
    owner.abort();
    let finished = false;
    const settled = fixture.launcher.settled().then((result) => {
      finished = true;
      return result;
    });
    if ("advanceNext" in clock && typeof clock.advanceNext === "function") {
      // Only run the held clock while this launcher is closing. Unrelated
      // repeating timers can survive on a clock shared with a fixture.
      const deadline = clock.monotonic() + 5_000;
      await turns();
      while (!finished && clock.advanceNext(deadline)) await turns();
      if (!finished)
        throw new Error(
          "Scripted launcher did not settle within five seconds of its held clock",
        );
    }
    const { unreaped } = await settled;
    if (unreaped.length)
      throw new Error(`Scripted processes unreaped: ${unreaped.join(", ")}`);
  };
  releaseTestFixture(close);
  return { ...fixture, ownerSignal: owner.signal, close };
}

export const unscriptedLauncher = () =>
  fixtureFakeLauncher(systemTimekeeper, {}).launcher;
