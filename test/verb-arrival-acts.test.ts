// [LAW:verifiable-goals] A copy or open a click asks says whether its writer
// carries it out, and that is decided by how the click arrived, in the one
// place verbs ask acts: a click delivered by a forwarder that asked for its acts
// on its machine says so on its copy and open, and no other arrival does.

import { SessionState } from "../src/renderer/session-state";
import { effectsUrl, VERB_COPY, VERB_OPEN_VSCODE } from "../src/click/wire";
import type { ClickArrival } from "../src/renderer-interface/click-arrival";
import { actsOf, clickUrl, testVerbContext, verbContextWith } from "./helpers/click";
import { TEST_SIGNER } from "./helpers/link-signer";

const URL = TEST_SIGNER.signLink(
  effectsUrl([
    { verb: VERB_COPY, args: ["text"] },
    { verb: VERB_OPEN_VSCODE, args: ["/work/repo"] },
  ]),
);

const asked = async (arrival: ClickArrival) => {
  const ctx = verbContextWith(testVerbContext(new SessionState()), { arrival });
  await clickUrl(URL, ctx);
  return actsOf(ctx).map((act) => ({
    kind: act.kind,
    forWriter: "forWriter" in act ? act.forWriter : undefined,
  }));
};

test("a click delivered for its forwarder's machine asks its copy and open for that machine", async () => {
  expect(
    await asked({
      via: "link",
      delivery: { kind: "desktop-forwarder", urlV: 2 },
    }),
  ).toEqual([
    { kind: "copy", forWriter: true },
    { kind: "open", forWriter: true },
  ]);
});

test.each<[string, ClickArrival]>([
  ["a forwarder that did not ask", { via: "link", delivery: { kind: "forwarder", urlV: 2 } }],
  ["the command line", { via: "link", delivery: { kind: "cli" } }],
  ["tmux's status line", { via: "tmux-status" }],
  ["a slash command", { via: "command" }],
])("a click arriving by %s asks its copy and open for the daemon's machine", async (_, arrival) => {
  expect(await asked(arrival)).toEqual([
    { kind: "copy", forWriter: undefined },
    { kind: "open", forWriter: undefined },
  ]);
});
