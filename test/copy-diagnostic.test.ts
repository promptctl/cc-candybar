// [LAW:verifiable-goals] A diagnostic's copy click names its message by key,
// and the copy-diagnostic verb copies what the session's last draw listed
// under that key: the full prompt reaches the clipboard while the link stays
// short, and a key that draw does not list is refused loudly.

import { collectDiagnostics, copyKeys } from "../src/render/diagnostics";
import { SessionState } from "../src/daemon/session-state";
import { DroppedFileError } from "../src/config/loader/diagnostics";
import { clickUrl, testVerbContext } from "./helpers/click";

// What the click asked the clipboard to hold, which the host then writes.
const copied: string[] = [];
const copy = (text: string) => void copied.push(text);

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
  copied.length = 0;
});

test("the first line's click copies the full prompt, though its link carries only a key", async () => {
  const { list, copies } = drawn();
  const link = list[0]!.lines[0]![0].link!;
  expect(link.length).toBeLessThan(200);
  expect(link).not.toContain("placement");
  await clickUrl(link, {
    ...testVerbContext(new SessionState()),
    copy,
    diagnosticCopy: (sid, by, key) =>
      sid === SID && by === "request" ? copies.get(key) : undefined,
  });
  expect(copied).toEqual([PROMPT]);
});

test("a key the session's last draw no longer lists is refused, and nothing is copied", async () => {
  const { list } = drawn();
  const link = list[0]!.lines[0]![0].link!;
  await expect(clickUrl(link, {
      ...testVerbContext(new SessionState()),
    copy,
      diagnosticCopy: () => undefined,
    }),
  ).rejects.toThrow(/no longer listed/);
  expect(copied).toEqual([]);
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
