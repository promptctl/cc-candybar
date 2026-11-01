// The settings menu's map: its tabs, its submenus, and where each setting's
// control sits among them. The menu (`settings-menu.ts`) lays its controls
// from it; text that sends a user to a control — the CLI's help, a lane's
// refusal — names the control's place from it, so moving a control moves
// every sentence that points at it.
//
// [LAW:one-way-deps] It imports only the settings table, so the CLI text and
// the lane gate can read it without importing the menu that imports them.
import {
  SETTINGS,
  SETTING_NAMES,
  perSetting,
  type SettingName,
} from "./setting-projections.js";
import { LANES, type Lane } from "./lanes.js";

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
// [LAW:types-are-the-program] The submenu names are spelled as a type of their
// own, before the table: a setting's row names its place, so the places must
// not be computed from a table whose type reads the settings.
export type SubmenuName = "gear" | "toggles";
export const SUBMENUS: Readonly<
  Record<
    SubmenuName,
    { readonly beside: SettingName; readonly trigger: string }
  >
> = {
  gear: { beside: "theme", trigger: "⚙" },
  toggles: { beside: "updateNotice", trigger: "🧪 toggles" },
};
export const SUBMENU_NAMES = Object.keys(SUBMENUS) as readonly SubmenuName[];

// Where a setting's control renders — the door's first line, exactly one
// tab, or inside a submenu. Each setting's row declares it
// (src/config/globals-fields.ts).
export type Place = "door" | TabName | SubmenuName;
export const PLACE: Readonly<Record<SettingName, Place>> = perSetting(
  (name) => SETTINGS[name].place,
);

// [LAW:types-are-the-program] The rows that can hang under a picker's list of
// options, each showing what the option in force does to the bar: the
// arrangement drawn block by block (`layout`), the open state and plane of the
// look (`palette`), and, on a preset the user made, the click that deletes it
// (`presetDelete`). A setting's row names the ones it shows; the menu draws
// each.
export type PreviewName = "layout" | "palette" | "presetDelete";

export const isSubmenu = (place: Place): place is SubmenuName =>
  Object.hasOwn(SUBMENUS, place);

// Whether a control at `place` is shown inside `container`: it is there, or in
// a submenu laid beside a control that is.
export const within = (place: Place, container: Place): boolean =>
  place === container ||
  (isSubmenu(place) && within(PLACE[SUBMENUS[place].beside], container));

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

// Every place that holds a control, in the order the menu opens them — the
// first line, then each tab, each followed by the submenus inside it — with
// the settings whose controls it holds, in the order it draws them.
interface PlaceSettings {
  readonly path: string;
  readonly names: readonly SettingName[];
}
export const settingsByPlace = (): readonly PlaceSettings[] =>
  (["door", ...TABS.map((t) => t.member)] as const)
    .flatMap((top): Place[] => [
      top,
      ...SUBMENU_NAMES.filter((s) => within(s, top)),
    ])
    .map((place) => ({
      path: placePath(place),
      names: SETTING_NAMES.filter((name) => PLACE[name] === place),
    }))
    .filter(({ names }) => names.length > 0);

// Why a subscriber of `lane` is refused, naming everything that admits it: the
// switch, and for a lane that needs tmux, a session inside a tmux pane — the
// refusal does not know which one failed, so it names both.
export const laneOffReason = (lane: Lane): string => {
  const { setting, on, inTmux } = LANES[lane].switch;
  return `${LANES[lane].label} is off — turn it on in the settings menu's ${settingMenuPath(setting)}, or set globals.${setting}: ${JSON.stringify(on)}${inTmux ? "; it runs only for a session inside a tmux pane" : ""}`;
};
