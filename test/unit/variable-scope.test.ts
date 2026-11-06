// Where a config's variables live (src/dsl/variable-scope.ts): every `shell`
// and `file` source is a session view's, whatever its cache policy reads,
// because what it read reaches a session through that session's facts
// document. And a directory's registry, which declares none, refuses one by
// name.

import { variableScopes } from "../../src/dsl/variable-scope";
import { Holds } from "../../src/utils/holds";
import { NO_RUNS } from "../../src/var-system/source-runs";
import { parseAndValidate } from "../helpers/parse-and-validate";

test("a shell or file source is the view's under every cache policy, and a literal the directory's", () => {
  const config = parseAndValidate(
    "<scopes>",
    JSON.stringify({
      variables: {
        greeting: { kind: "literal", value: "hi" },
        hourly: { kind: "shell", command: "uptime", cache: { ttl: "1h" } },
        once: { kind: "shell", command: "date", cache: { never: true } },
        keyed: {
          kind: "shell",
          command: "date",
          cache: { key: "{{ .greeting }}" },
        },
        watched: {
          kind: "file",
          path: "/tmp/ccb-scope-note",
          cache: { watch_file: "/tmp/ccb-scope-note" },
        },
      },
      segments: {
        s: {
          template:
            "{{ .greeting }} {{ .hourly }} {{ .once }} {{ .keyed }} {{ .watched }}",
        },
      },
      root: { h: ["s"] },
    }),
  );
  expect(Object.fromEntries(variableScopes(config))).toMatchObject({
    greeting: "directory",
    hourly: "view",
    once: "view",
    keyed: "view",
    watched: "view",
  });
});

test("a directory's registry declaring a run is refused, naming the run", () => {
  expect(() =>
    NO_RUNS.declare(new Holds(), {
      read: { kind: "shell", command: "uptime", cwd: "/w" },
      parse: { kind: "text" },
      refresh: { kind: "never" },
    }),
  ).toThrow(
    'a directory declares no shell or file source, and output of "uptime" in /w was declared in one',
  );
});
