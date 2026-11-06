// The tmux server's one status-line click binding (docs/design/gather-and-
// renderer.md, section 18), as data: the text every renderer binds, the click
// each session carries for it, the user's own binding read back out of it, and
// the call that puts the user's back.
//
// [LAW:one-source-of-truth] The binding names no renderer, so every renderer
// on a server writes the same text and none of them owns it. What differs per
// renderer (its handler, its name, its mac) is the session's, written by the
// renderer that draws that session's row, and the binding reads it at the
// click. The user's binding lives in one place, the binding's own else-branch,
// so no record beside it can be lost or disagree with it.

import { addressedLink, encodeSegments, VERB_RANGE } from "../click/wire.js";
import type { RendererAddress } from "../daemon/home.js";
import { RANGE_PREFIX } from "./link-ids.js";
import {
  boundText,
  commandText,
  tmuxCommands,
  tmuxQuoted,
  type CommandList,
} from "./tmux-words.js";

export const CLICK_KEY = ["-T", "root", "MouseDown1Status"] as const;

// The renderer drawing a session's row, by name. Set when the renderer takes
// hold of the session and unset with its restore, so a row no renderer holds
// names none, and the binding stays bound while any session names one.
export const RENDERER_OPTION = "@cc-candybar-renderer";

// What a click on a session's ranges runs, up to the pane: the handler of the
// renderer that drew the row, under that renderer's home, and the link
// addressed to it. One option, so a session never carries half of a click.
export const CLICK_OPTION = "@cc-candybar-click";

// [LAW:single-enforcer] The one builder of the status-line click's URL. The
// binding adds the pane (its `%` stripped, which a URL would read as an
// escape) and the range, which tmux expands, shell-quoted, at the click; the
// mac proves the click came through a binding, because a range id is a counter
// anyone can guess and any web page can open a `cc-candybar://` URL.
export function sessionClick(
  handler: string,
  name: RendererAddress,
  socket: string,
  mac: string,
): string {
  return `${handler} ${addressedLink(name, VERB_RANGE, encodeSegments([socket, mac]))}`;
}

// What a click on a `ccb` range says where its session carries no click: a
// row an older build drew, which names its renderer but writes no click.
export const NO_RENDERER =
  "cc-candybar: no renderer takes clicks on this row: the one that drew it is older than this binding";

// The test every cc-candybar binding of every build opens with: the press was
// on a range of ours. It is what tells ours from the user's, by shape.
const OUR_RANGE = `#{m:${RANGE_PREFIX}*,#{mouse_status_range}}`;

// The binding, bound over the user's command list (null: none). A click on a
// range of ours runs the session's click; any other runs the user's list.
export function clickBinding(user: CommandList | null): string[] {
  const run = `run-shell -b ${tmuxQuoted(`#{${CLICK_OPTION}}/#{s/%//:pane_id}/#{q:mouse_status_range}`)}`;
  const said = `display-message ${tmuxQuoted(NO_RENDERER)}`;
  return [
    "bind-key",
    ...CLICK_KEY,
    "if-shell",
    "-F",
    OUR_RANGE,
    `if-shell -F ${tmuxQuoted(`#{${CLICK_OPTION}}`)} ${tmuxQuoted(run)} ${tmuxQuoted(said)}`,
    ...(user === null ? [] : [commandText(user)]),
  ];
}

// The command a root `MouseDown1Status` binding runs, as `list-keys` prints
// the line binding it: a note and a repeat flag may sit before the table, and
// a whole table's listing pads the key's column with spaces.
const LISTED =
  /^bind-key\s+(?:-r\s+)?(?:-N\s+(?:"(?:[^"\\]|\\.)*"|\S+)\s+)?-T\s+root\s+MouseDown1Status\s+(.+)$/m;

// One of our bindings' else-branch, the list it chains (null: none), or
// undefined where the list is not one of ours.
function chained(list: CommandList): CommandList | null | undefined {
  const [only, ...more] = list;
  if (only === undefined || more.length > 0 || only[0] !== "if-shell")
    return undefined;
  let operands = only.slice(1);
  while (typeof operands[0] === "string" && operands[0].startsWith("-"))
    operands = operands.slice(1);
  if (operands[0] !== OUR_RANGE) return undefined;
  const otherwise = operands[2];
  const chain =
    otherwise === undefined
      ? []
      : typeof otherwise === "string"
        ? tmuxCommands(otherwise)
        : otherwise.block;
  // An else-branch of no commands chains none, as an absent one does.
  return chain.length > 0 ? chain : null;
}

// [LAW:parse-dont-validate] MouseDown1Status as a listing holds it: whether
// what is bound is one of ours, and the user's own list under every binding of
// ours chained over it (an older build can bind over this one), so neither a
// bind nor a restore ever takes one of ours for the user's. `user` is null
// where the chain ends with none, as an unbound key does.
export interface Bound {
  readonly ours: boolean;
  readonly user: CommandList | null;
}

export function boundOf(listKeys: string): Bound {
  const printed = LISTED.exec(listKeys)?.[1];
  let user: CommandList | null =
    printed === undefined ? null : tmuxCommands(printed);
  const ours = user !== null && chained(user) !== undefined;
  while (user !== null) {
    const next = chained(user);
    if (next === undefined) break;
    user = next;
  }
  return { ours, user };
}

// What the bind and the restore print, so the owner can say which way tmux
// went.
export const BOUND = "ccb:bound";
export const RESTORED = "ccb:restored";
export const HELD = "ccb:held";

// Whether any session names a renderer, as tmux decides it: a session counts
// by whether it carries a name at all, because tmux reads a name such as `0`
// as false (measured).
export const NAMED = `#{S:#{?#{!=:#{${RENDERER_OPTION}},},1,}}`;

// [LAW:no-ambient-temporal-coupling] The binding written, decided by tmux in
// the call that writes it: only while a session names a renderer, so a bind
// still in flight when the last renderer has restored lands on nothing, as a
// draw does.
export function bindClick(user: CommandList | null): string[] {
  return [
    "if-shell",
    "-F",
    NAMED,
    `${commandText([clickBinding(user)])} ; display-message -p ${BOUND}`,
  ];
}

// [LAW:no-ambient-temporal-coupling] Putting the user's binding back, decided
// by tmux in the call that writes it: only while no session names a renderer,
// so one that named itself since the listing was read keeps its clicks.
export function restoreBinding(user: CommandList | null): string[] {
  const put =
    user === null
      ? `unbind-key ${CLICK_KEY.join(" ")}`
      : `bind-key ${CLICK_KEY.join(" ")} ${boundText(user)}`;
  return [
    "if-shell",
    "-F",
    `#{!:${NAMED}}`,
    `${put} ; display-message -p ${RESTORED}`,
    `display-message -p ${HELD}`,
  ];
}
