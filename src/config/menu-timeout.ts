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
export const MENU_TIMEOUT_RANGE = { min: 15, max: 600, step: 15 } as const;
export const MENU_TIMEOUT_DEFAULT = 120;

// The instant a session's menus close, its idle period having begun at `since`.
export const closesAt = (since: Instant, timeoutS: number): Instant =>
  (since + timeoutS) as Instant;

// How far into a session's idle period its flash begins: the flash ends at
// exactly the close. [LAW:one-source-of-truth] The render's flash is one
// animation over the whole idle period, dark until this moment, so every frame
// of an idle menu says when the flash starts. It is positive because the
// setting's range starts above the flash's length (MENU_TIMEOUT_RANGE), which a
// flash starting before the idle period could not draw.
export const flashBegins = (timeoutS: number): number =>
  timeoutS - CLOSING_FLASH_SECONDS;

// Whether the flash is lit `t` seconds in.
export function litAt(t: number): boolean {
  let start = 0;
  for (const { lit, seconds } of CLOSING_FLASH) {
    if (t < start + seconds) return lit;
    start += seconds;
  }
  return false;
}
