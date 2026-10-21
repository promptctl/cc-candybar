// The settings menu's map: its tabs, its submenus, and where each setting's
// control sits among them. The menu (`settings-menu.ts`) lays its controls
// from it; text that sends a user to a control — the CLI's help, a lane's
// refusal — names the control's place from it, so moving a control moves
// every sentence that points at it.
//
// [LAW:one-way-deps] A leaf: it imports only a type, so the CLI text and the
// lanes can read it without importing the menu that imports them.
import type { SettingName } from "./setting-projections.js";

// The tabs the door opens onto, in strip order.
export const TABS = [
  { member: "session", label: "⚡ session" },
  { member: "look", label: "🎨 look" },
  // `📐`, because `▦` is the preset control's glyph.
  { member: "layout", label: "📐 layout" },
  { member: "config", label: "⚙ config" },
  { member: "tools", label: "🧰 tools" },
] as const;
export type TabName = (typeof TABS)[number]["member"];
// [LAW:types-are-the-program] Total over TABS: the one place the totality
// `Object.fromEntries` cannot see is asserted.
export const TAB_LABEL = Object.fromEntries(
  TABS.map((t) => [t.member, t.label]),
) as Readonly<Record<TabName, string>>;

// [LAW:one-type-per-behavior] A submenu is a disclosure laid right after one
// setting's control, on the accordion that control sits on, whose body holds
// the controls `PLACE` puts in it. The theme picker is `[Theme ▀▀▀] [⚙]`, and
// the gear opens "the theme configuration menu … bright/dim, etc, and the
// primary/secondary, etc": the settings that adapt the theme rather than
// choose it. The toggles menu (Brandon: "Put the three feature toggles we
// added into the menu, as a toggles menu under config") holds the switches
// for experimental features.
export const SUBMENUS = {
  gear: { beside: "theme", trigger: "⚙" },
  toggles: { beside: "updateNotice", trigger: "🧪 toggles" },
} as const satisfies Readonly<
  Record<string, { readonly beside: SettingName; readonly trigger: string }>
>;
export type SubmenuName = keyof typeof SUBMENUS;
export const SUBMENU_NAMES = Object.keys(SUBMENUS) as readonly SubmenuName[];

// [LAW:types-are-the-program] Where each setting's control renders — the
// door's first line, exactly one tab, or inside a submenu — as a record keyed
// by every setting, so a new setting is a compile error until it is given a
// place. Switching arrangement is what people open this menu for, so the
// preset control sits on the door's first line, one click from the door.
export type Place = "door" | TabName | SubmenuName;
export const PLACE = {
  preset: "door",
  theme: "look",
  style: "gear",
  effect: "look",
  variation: "gear",
  shade: "gear",
  endcaps: "look",
  transitions: "look",
  autoWrap: "layout",
  padding: "layout",
  updateNotice: "config",
  experimentalBand: "toggles",
  experimentalStatusline: "toggles",
  experimentalPane: "toggles",
} as const satisfies Readonly<Record<SettingName, Place>>;

export const isSubmenu = (place: Place): place is SubmenuName =>
  Object.hasOwn(SUBMENUS, place);

// A submenu sits beside a control, so what is inside it is in that control's
// tab.
export const tabOf = (place: Place): "door" | TabName =>
  isSubmenu(place) ? tabOf(PLACE[SUBMENUS[place].beside]) : place;

// Where a place is, in the words the menu draws: the tab's label, then each
// submenu's trigger.
const placePath = (place: Place): string =>
  isSubmenu(place)
    ? `${placePath(PLACE[SUBMENUS[place].beside])} › ${SUBMENUS[place].trigger}`
    : place === "door"
      ? "first line"
      : TAB_LABEL[place];

// Where a setting's control is in the settings menu — `⚙ config › 🧪 toggles`.
export const settingMenuPath = (name: SettingName): string =>
  placePath(PLACE[name]);
