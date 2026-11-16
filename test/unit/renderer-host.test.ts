// The host's one path for a push (src/daemon/renderer-host.ts): `ask` hands
// back the reply of the push's own kind or rejects, and `tell` says a failure
// on the log, since nothing awaits it.

import { NO_ACTS } from "../helpers/renderer-parts";
import { rendererHost } from "../../src/daemon/renderer-host";
import { failureOf } from "../../src/daemon/foundations/verb-error";
import type { AdapterOutput } from "../../src/renderer-interface/interface";
import { instantOf } from "../../src/utils/instant";
import type { Monotonic } from "../../src/time";
import { pushRenderer } from "../helpers/renderers";

const AT = instantOf(new Date(0));

// A host over a renderer that answers every push with `output`; `said`
// settles with the first line it logs.
function hostOver(output: AdapterOutput) {
  let say: (line: string) => void = () => {};
  const said = new Promise<string>((resolve) => (say = resolve));
  const host = rendererHost(
    "main",
    { now: () => 0, monotonic: () => 0 as Monotonic },
    pushRenderer(async () => output),
    (level, line) => say(`${level} ${line}`),
    {
      subscribed: () => {
        throw new Error("a push names no subscriptions");
      },
      holding: () => {
        throw new Error("a push holds no session");
      },
    },
    NO_ACTS,
  );
  return { host, said };
}

test("an ask is handed the reply of its push's own kind", async () => {
  const { host } = hostOver({
    kind: "replied",
    reply: { kind: "lanes", lanes: null },
  });
  expect(await host.ask({ kind: "lanes", session: "s" as never }, AT)).toEqual({
    kind: "lanes",
    lanes: null,
  });
});

test("an ask answered with another push's reply rejects, naming both", async () => {
  const { host } = hostOver({ kind: "replied", reply: { kind: "pin" } });
  await expect(
    host.ask({ kind: "lanes", session: "s" as never }, AT),
  ).rejects.toThrow("renderer main answered push lanes with a pin reply");
});

test("an ask whose push threw rejects with the renderer's failure", async () => {
  const { host } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("the view broke")),
  });
  await expect(host.ask({ kind: "stats" }, AT)).rejects.toThrow(
    /renderer main push stats threw: .*the view broke/,
  );
});

test("a tell that fails is said on the log, and nothing rejects", async () => {
  const { host, said } = hostOver({
    kind: "threw",
    failure: failureOf(new Error("no such session")),
  });
  expect(host.tell({ kind: "unpin", session: "s" as never }, AT)).toBe(
    undefined,
  );
  expect(await said).toMatch(
    /^error renderer main push unpin threw: .*no such session/,
  );
});
