// The step that gives a drawn frame the links its lane's click mode means:
// each named region keeps the binding its mode asks for, or no link at all,
// and a link no region owns is the same in every mode.

import { inClickMode } from "../../src/render/click-mode-frame";
import { actionTarget, type DrawnEffect } from "../../src/render/drawn-link";
import type { Frame, Run } from "../../src/render/frame";
import { CLICK_MODES } from "../../src/config/click-mode";

const write = (value: string): readonly DrawnEffect[] => [
  { verb: "set-state", args: ["s", "k", value] },
];

const named = (text: string, bindings: Record<string, string>): Run => ({
  text,
  link: actionTarget(write("plain"), undefined, {
    name: text,
    gestures: Object.fromEntries(
      Object.entries(bindings)
        .filter(([gesture]) => gesture !== "hover")
        .map(([gesture, value]) => [gesture, write(value)]),
    ),
    ...(bindings.hover === undefined ? {} : { hover: write(bindings.hover) }),
  }),
});

const FRAME: Frame = {
  depth: "truecolor",
  rows: [
    {
      kind: "bar",
      runs: [
        named("both", { "alt+left": "alt", hover: "hover" }),
        named("none", {}),
        { text: "row", link: actionTarget(write("row")) },
        { text: "web", link: "https://example.com" },
      ],
    },
  ],
  nextChange: Infinity,
  motion: "still",
  pending: [],
};

// What a click on each run does: its effects, or "no link".
function clicks(mode: (typeof CLICK_MODES)[number]) {
  return Object.fromEntries(
    inClickMode(FRAME, mode).rows[0]!.runs.map((run) => [
      run.text,
      run.link === undefined
        ? "no link"
        : typeof run.link === "string"
          ? run.link
          : run.link.kind === "action"
            ? run.link.effects.map((e) => ("args" in e ? e.args[2] : "run"))
            : run.link.kind,
    ]),
  );
}

describe("a frame in a click mode", () => {
  test("click: every region keeps its own click", () => {
    expect(clicks("click")).toEqual({
      both: ["plain"],
      none: ["plain"],
      row: ["row"],
      web: "https://example.com",
    });
  });

  test("alt: a region with no alt+click binding has no link", () => {
    expect(clicks("alt")).toEqual({
      both: ["alt"],
      none: "no link",
      row: ["row"],
      web: "https://example.com",
    });
  });

  test("hover: a region with no hover binding has no link, and none carries the binding afterwards", () => {
    expect(clicks("hover")).toEqual({
      both: ["hover"],
      none: "no link",
      row: ["row"],
      web: "https://example.com",
    });
    for (const mode of CLICK_MODES)
      for (const run of inClickMode(FRAME, mode).rows[0]!.runs)
        if (typeof run.link !== "string" && run.link?.kind === "action")
          expect(run.link.region?.hover).toBeUndefined();
  });
});
