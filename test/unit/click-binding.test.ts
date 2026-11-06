// The server's click binding as a renderer reads it back from tmux's listing
// (src/tmux-status/click-binding.ts): whether it is ours, and the user's own
// command list under every binding of ours. Each listing line is one tmux 3.8
// printed.

import { boundOf, clickBinding } from "../../src/tmux-status/click-binding";
import {
  commandText,
  tmuxCommands,
  type CommandList,
} from "../../src/tmux-status/tmux-words";

// A root table listing whose MouseDown1Status runs `printed`, padded as a
// whole table's listing pads the key column.
const listing = (printed: string): string =>
  [
    "bind-key  -T root MouseDown1Pane            select-pane -t =",
    `bind-key  -T root MouseDown1Status          ${printed}`,
  ].join("\n") + "\n";

// Our binding as tmux prints it back, over `user`.
const ours = (user: CommandList | null): string => {
  const [, , , , ...command] = clickBinding(user);
  return command
    .map((w) =>
      /[ #';${}%"]/.test(w)
        ? `"${w.replace(/\\/g, "\\\\").replace(/["$]/g, (c) => `\\${c}`)}"`
        : w,
    )
    .join(" ");
};

describe("the user's binding a listing holds", () => {
  test.each([
    ["the server's own", "switch-client -t =", [["switch-client", "-t", "="]]],
    ["one bare word", "select-pane", [["select-pane"]]],
    [
      "a single-quoted word",
      `display-message 'a"b'`,
      [["display-message", 'a"b']],
    ],
    [
      "escaped quotes, a dollar and a backslash",
      `display-message "say \\"hi\\" \\$HOME \\\\x"`,
      [["display-message", 'say "hi" $HOME \\x']],
    ],
    ["a tab", "display-message tab\\there", [["display-message", "tab\there"]]],
    [
      "an octal byte and UTF-8",
      `display-message "bell\\001 é"`,
      [["display-message", "bell\u0001 é"]],
    ],
    [
      "a ; inside a quoted word",
      `display-message "semi;colon ; not a separator"`,
      [["display-message", "semi;colon ; not a separator"]],
    ],
    [
      "a command list",
      `select-pane \\; display-message "hi there"`,
      [["select-pane"], ["display-message", "hi there"]],
    ],
    [
      "one that mentions cc-candybar",
      `run-shell "cc-candybar doctor"`,
      [["run-shell", "cc-candybar doctor"]],
    ],
    [
      "an if-shell over blocks",
      `if-shell -F "#{==:1,1}" { select-window -t = ; display-message hi } { display-message no }`,
      [
        [
          "if-shell",
          "-F",
          "#{==:1,1}",
          {
            block: [
              ["select-window", "-t", "="],
              ["display-message", "hi"],
            ],
          },
          { block: [["display-message", "no"]] },
        ],
      ],
    ],
    [
      "a command list ending in a block with a brace and a ; quoted inside",
      `select-window -t = \\; if-shell -F 1 { display-message "a }b" ; display-message "c;d" }`,
      [
        ["select-window", "-t", "="],
        [
          "if-shell",
          "-F",
          "1",
          {
            block: [
              ["display-message", "a }b"],
              ["display-message", "c;d"],
            ],
          },
        ],
      ],
    ],
    [
      "a block whose command takes a ; argument",
      `if-shell -F 1 { send-keys \\; }`,
      [["if-shell", "-F", "1", { block: [["send-keys", ";"]] }]],
    ],
    [
      "a word that starts with an escaped ~",
      `send-keys \\~/foo "\\~x y"`,
      [["send-keys", "~/foo", "~x y"]],
    ],
    [
      "a string beside a block, each holding a brace",
      `if-shell -F 1 "display-message \\"{ x }\\"" { display-message \\{ }`,
      [
        [
          "if-shell",
          "-F",
          "1",
          'display-message "{ x }"',
          { block: [["display-message", "{"]] },
        ],
      ],
    ],
  ])("is %s, read as the user's", (_what, printed, user) => {
    expect(boundOf(listing(printed))).toEqual({ ours: false, user });
  });

  test("a note before the table does not hide the binding", () => {
    expect(
      boundOf(
        `bind-key -N "Pick a window" -T root MouseDown1Status switch-client -t =\n`,
      ).user,
    ).toEqual([["switch-client", "-t", "="]]);
  });

  test("an unbound key holds none", () => {
    expect(
      boundOf("bind-key  -T root MouseDown1Pane select-pane -t =\n"),
    ).toEqual({ ours: false, user: null });
  });

  test("under ours, it is the else-branch this build wrote, its commands joined by ` ; `", () => {
    const user = [["select-pane"], ["display-message", "hi there"]];
    expect(commandText(user)).toBe(
      `"select-pane" ; "display-message" "hi there"`,
    );
    expect(boundOf(listing(ours(user)))).toEqual({ ours: true, user });
    expect(boundOf(listing(ours(null)))).toEqual({ ours: true, user: null });
  });

  test("under ours, a block in the user's list is still a block", () => {
    const user: CommandList = [
      [
        "if-shell",
        "-F",
        "#{==:1,1}",
        {
          block: [
            ["select-window", "-t", "="],
            ["display-message", "hi"],
          ],
        },
        { block: [["display-message", "no"]] },
      ],
    ];
    expect(boundOf(listing(ours(user)))).toEqual({ ours: true, user });
  });

  // An older build wrote its prior's printed text as the else-branch, so its
  // separator reads `\\;` inside the quoted word.
  test("under an older build's binding over ours, it is the innermost else-branch that is not ours", () => {
    const user = [["select-pane"], ["display-message", "hi there"]];
    const older = `if-shell -F "#{m:ccb*,#{mouse_status_range}}" "run-shell -b \\"old url-handle cc-candybar://to/main/tmux-status-click/x\\"" "${ours(user).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    expect(boundOf(listing(older))).toEqual({ ours: true, user });
    const direct = `if-shell -F "#{m:ccb*,#{mouse_status_range}}" "run-shell -b old" "select-pane \\\\; display-message \\"hi there\\""`;
    expect(boundOf(listing(direct))).toEqual({ ours: true, user });
  });

  test("an if-shell of the user's own, on another test, is the user's", () => {
    const printed = `if-shell -F "#{pane_in_mode}" "send-keys -X cancel" "switch-client -t ="`;
    expect(boundOf(listing(printed))).toEqual({
      ours: false,
      user: tmuxCommands(printed),
    });
  });
});
