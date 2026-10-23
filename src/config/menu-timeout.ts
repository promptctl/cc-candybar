// [LAW:one-source-of-truth] When a menu nobody is using closes on its own, and
// the flash it wears first (brandon-menus-sjhy.my3): `menuTimeout` seconds after
// the session's last click, the flash ending at exactly that instant. The
// daemon's close timer (src/daemon/menu-idle.ts) and the render's flash
// (`SessionEffects.motion`) both read the deadline from here, so the flash
// cannot end anywhere but where the menu closes.
//
// [LAW:effects-at-boundaries] Pure: instants in, a time or a hold out.

import type { Instant } from "../utils/instant.js";

// One hold of the flash: lit, or dark, for so long.
export interface FlashHold {
  readonly lit: boolean;
  readonly seconds: number;
}

const flashes = (count: number, seconds: number): FlashHold[] =>
  Array.from({ length: count * 2 }, (_, i) => ({ lit: i % 2 === 0, seconds }));

// Brandon's "three slow flashes, then three faster ones". A slow flash holds a
// whole second lit and a second dark, because Claude Code redraws its
// statusline at most once a second, so a faster beat would land on one side
// of it every redraw. The fast ones only show where frames are pushed.
export const CLOSING_FLASH: readonly FlashHold[] = [
  ...flashes(3, 1),
  ...flashes(3, 0.25),
];

export const CLOSING_FLASH_SECONDS = CLOSING_FLASH.reduce(
  (sum, { seconds }) => sum + seconds,
  0,
);

// The setting's range, in seconds. A timeout shorter than the flash would
// start flashing before the click that opened the menu.
export const MENU_TIMEOUT_RANGE = { min: 10, max: 600, step: 5 } as const;
export const MENU_TIMEOUT_DEFAULT = 30;

// The instant a session's menus close, its idle period having begun at `since`.
export const closesAt = (since: Instant, timeoutS: number): Instant =>
  (since + timeoutS) as Instant;

// How far into its flash a menu drawn at `at` is, or null while it is not
// flashing.
export function flashAt(
  since: Instant,
  timeoutS: number,
  at: Instant,
): number | null {
  const t = at - (closesAt(since, timeoutS) - CLOSING_FLASH_SECONDS);
  return t >= 0 && t < CLOSING_FLASH_SECONDS ? t : null;
}

// Whether the flash is lit `t` seconds in.
export function litAt(t: number): boolean {
  let start = 0;
  for (const { lit, seconds } of CLOSING_FLASH) {
    if (t < start + seconds) return lit;
    start += seconds;
  }
  return false;
}
