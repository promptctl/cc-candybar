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

// The tabs the door opens onto, and the line of the menu each one's trigger
// leads from: the first line, beside ◁, holds what the menu is most often
// opened for, and the strip under it the rest. Each line lists its tabs in
// this order, and every tab is one accordion whichever line it sits on.
export type TabLine = "first" | "strip";
export const TABS = [
  { member: "look", label: "🎨 look", line: "first" },
  { member: "presets", label: "📚 saves & presets", line: "first" },
  { member: "session", label: "⚡ session", line: "strip" },
  { member: "config", label: "⚙ config", line: "strip" },
] as const satisfies ReadonlyArray<{
  readonly member: string;
  readonly label: string;
  readonly line: TabLine;
}>;
export const tabsOnLine = (line: TabLine) =>
  TABS.filter((tab) => tab.line === line);
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
// choose it. The renderer menu holds the switches for the displays that
// draw the bar beyond Claude Code's polled statusline.
// [LAW:types-are-the-program] The submenu names are spelled as a type of their
// own, before the table: a setting's row names its place, so the places must
// not be computed from a table whose type reads the settings.
export type SubmenuName = "gear" | "renderer";
export const SUBMENUS: Readonly<
  Record<
    SubmenuName,
    { readonly beside: SettingName; readonly trigger: string }
  >
> = {
  gear: { beside: "theme", trigger: "⚙" },
  renderer: { beside: "padding", trigger: "📺 renderer" },
};
export const SUBMENU_NAMES = Object.keys(SUBMENUS) as readonly SubmenuName[];

// Where a setting's control renders — exactly one tab, or inside a submenu.
// Each setting's row declares it (src/config/globals-fields.ts).
export type Place = TabName | SubmenuName;
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
    : TAB_LABEL[place];

// Where a setting's control is in the settings menu — `⚙ config › 📺 renderer`.
export const settingMenuPath = (name: SettingName): string =>
  placePath(PLACE[name]);

// Both the menu and CLI help traverse the same rows. Settings sharing a line
// retain the order of their declarations.
export function settingRows(place: Place): SettingName[][] {
  const settings = SETTING_NAMES.filter((name) => PLACE[name] === place);
  const lines = [...new Set(settings.map((name) => SETTINGS[name].line))];
  return lines
    .sort((a, b) => a - b)
    .map((line) => settings.filter((name) => SETTINGS[name].line === line));
}

// Every place that holds a control, in the order the menu opens them — each
// tab, followed by the submenus inside it — with
// the settings whose controls it holds, in the order it draws them.
interface PlaceSettings {
  readonly path: string;
  readonly names: readonly SettingName[];
}
export const settingsByPlace = (): readonly PlaceSettings[] =>
  TABS.map((t) => t.member)
    .flatMap((top): Place[] => [
      top,
      ...SUBMENU_NAMES.filter((s) => within(s, top)),
    ])
    .map((place) => ({
      path: placePath(place),
      names: settingRows(place).flat(),
    }))
    .filter(({ names }) => names.length > 0);

// The preference that admits a subscriber of this lane.
export const laneOffReason = (lane: Lane): string => {
  const { setting, on } = LANES[lane].switch;
  return `${LANES[lane].label} is off — turn it on in the settings menu's ${settingMenuPath(setting)}, or set globals.${setting}: ${JSON.stringify(on)}`;
};
