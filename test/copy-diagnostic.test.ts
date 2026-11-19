// [LAW:verifiable-goals] A diagnostic's copy click names its message by key,
// and the copy-diagnostic verb copies what the session's last draw listed
// under that key: the full prompt reaches the clipboard while the link stays
// short, and a key that draw does not list is refused loudly.

import { clickLaunchVia } from "../src/daemon/foundations/click-launch";
import { type LaunchOpts } from "../src/proc/launcher";
import { unscriptedLauncher } from "./helpers/fake-launcher";
import { collectDiagnostics, copyKeys } from "../src/render/diagnostics";
import { SessionState } from "../src/renderer/session-state";
import { hrefOfDrawnLink } from "../src/render/drawn-link";
import { DroppedFileError } from "../src/config/loader/diagnostics";
import { clickActing, clickUrl, testVerbContext,
  verbContextWith } from "./helpers/click";
import {
  effectsUrl,
  VERB_COPY,
  VERB_COPY_DIAGNOSTIC,
} from "../src/click/wire";
import { CrossedFailure } from "../src/daemon/foundations/verb-error";
import { lastClickError } from "../src/daemon/foundations/click-error";
import { sessionIdOf } from "../src/daemon/foundations/session-id";

const launched: LaunchOpts[] = [];
const recording = {
  ...unscriptedLauncher,
  launch: async (opts: LaunchOpts) => {
    launched.push(opts);
    return { ok: true as const, exitCode: 0, stdout: "", stderr: "" };
  },
};

const SID = "sid-copy";
const PROMPT = `Fix my config.\n\n${"a placement that names nothing; ".repeat(200)}`;

const drawn = () => {
  const list = collectDiagnostics(
    SID,
    "request",
    [{ about: "dropped\0/x.json5", text: "first line\nsecond", copy: PROMPT }],
    [],
    [],
  );
  const keys = copyKeys(list);
  const copies = new Map(list.map((m, i) => [keys[i]!, m.copy]));
  return { list, copies };
};

beforeEach(() => {
  launched.length = 0;
});

test("the first line's click copies the full prompt, though its link carries only a key", async () => {
  const { list, copies } = drawn();
  const target = list[0]!.lines[0]![0].link;
  if (target === null) throw new Error("missing copy link");
  const link = hrefOfDrawnLink(target);
  expect(link.length).toBeLessThan(200);
  expect(link).not.toContain("placement");
  const outcomes = await clickActing(
    link,
    verbContextWith(testVerbContext(new SessionState()), {
      diagnosticCopy: (sid, by, key) =>
        sid === SID && by === "request" ? copies.get(key) : undefined,
    }),
    { launch: clickLaunchVia(recording) },
  );
  expect(outcomes).toEqual([{ kind: "ok" }]);
  expect(launched).toHaveLength(1);
  expect(launched[0]!.bin).toBe("/usr/bin/pbcopy");
  expect(launched[0]!.stdinInput).toBe(PROMPT);
});

test("a key the session's last draw no longer lists is refused, and nothing is copied", async () => {
  const { list } = drawn();
  const target = list[0]!.lines[0]![0].link;
  if (target === null) throw new Error("missing copy link");
  await expect(
    clickActing(
      hrefOfDrawnLink(target),
      verbContextWith(testVerbContext(new SessionState()), {
        diagnosticCopy: () => undefined,
      }),
      { launch: clickLaunchVia(recording) },
    ),
  ).rejects.toThrow(/no longer listed/);
  expect(launched).toHaveLength(0);
});

// A copy names no session of its own: one in a click that names a session is
// that session's act, so its failure holds on that bar, not on every bar.
test("a copy in a click that names a session fails on that session's bar", async () => {
  const state = new SessionState();
  const ctx = testVerbContext(state);
  const outcomes = await clickActing(
    effectsUrl([
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "key"] },
      { verb: VERB_COPY, args: ["x"] },
    ]),
    verbContextWith(ctx, { diagnosticCopy: () => PROMPT }),
    {
      launch: async (opts) => opts.stdinInput === PROMPT
        ? { ok: true, exitCode: 0, stdout: "", stderr: "" }
        : ({
        ok: false,
        reason: "non-zero",
        stdout: "",
        stderr: "no pasteboard",
        exitCode: 1,
        signal: null,
      }),
    },
  );
  expect(outcomes).toEqual([
    { kind: "ok" },
    { kind: "failed", reason: expect.stringMatching(/^copy: pbcopy failed/) },
  ]);
  expect(lastClickError(state, sessionIdOf(SID))?.text).toMatch(
    /^copy: pbcopy failed/,
  );
});

// [LAW:single-enforcer] A step cut off by the daemon's close keeps that class
// through the click's fold: no error of its own on the bar, and the click
// answered as closing, not as a failure.
test("a step the daemon's close cut off keeps its class, and holds nothing on the bar", async () => {
  const state = new SessionState();
  const closing = new CrossedFailure({
    kind: "closing",
    message: "the daemon closed: copy-diagnostic refused",
    detail: "",
  });
  const clicked = clickUrl(
    effectsUrl([
      { verb: VERB_COPY_DIAGNOSTIC, args: [SID, "request", "k"] },
    ]),
    verbContextWith(testVerbContext(state), {
      diagnosticCopy: () => {
        throw closing;
      },
    }),
  );
  await expect(clicked).rejects.toBe(closing);
  expect(lastClickError(state, sessionIdOf(SID))).toBeNull();
});

test("a dropped placement's prompt names the file to edit and carries the error whole", () => {
  const e = new DroppedFileError("/home/me/config.json5", [
    {
      path: "root",
      message: 'root entry "x" does not match any declared segment',
    },
  ]);
  expect(e.prompt).toMatch(
    /^Fix my cc-candybar statusline config\.[\s\S]*Config file to edit: \/home\/me\/config\.json5\n\nInvalid config in \/home\/me\/config\.json5[\s\S]*root entry "x"[\s\S]*Edit only the config file/,
  );
});
