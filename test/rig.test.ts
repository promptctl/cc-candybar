// What the rig promises a test that builds it: the parse and the compile of one
// source are shared between rigs, and everything that holds a subscription or a
// session's picks is a rig's own.
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
import { settingNameOf } from "../src/config/globals-fields";
import { registerOptionDomain } from "../src/config/option-domain";
import { compileInputOf, compileKey } from "../src/dsl/render";
import { textOf } from "../src/render/frame";
import { buildRig, parsedConfig, sharedCompile } from "./helpers/rig";

const SOURCE = `{
  segments: { a: { template: 'hello', bg: 'surface', fg: 'foreground' } },
  root: { v: ['a'] },
}`;

describe("buildRig", () => {
  test("two rigs from one source share one parse and one compile", () => {
    const first = buildRig({ source: SOURCE });
    const second = buildRig({ source: SOURCE });
    try {
      expect(second.config).toBe(first.config);
      expect(second.compiled.segments).toBe(first.compiled.segments);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("a rig's store, registry and session are its own", () => {
    const first = buildRig({ source: SOURCE });
    const second = buildRig({ source: SOURCE });
    try {
      expect(second.store).not.toBe(first.store);
      expect(second.registry).not.toBe(first.registry);
      expect(second.sessionState).not.toBe(first.sessionState);
      first.sessionState.set(first.sessionId, "theme", "nord");
      expect(second.sessionState.get(second.sessionId, "theme")).toBeNull();
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  test("a different source or base is a different parse", () => {
    const base = parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG);
    const other = parsedConfig("<test>", `${SOURCE} `, DEFAULT_DSL_CONFIG);
    const emptyBase = buildRig({ source: SOURCE });
    try {
      expect(other).not.toBe(base);
      expect(emptyBase.config).not.toBe(base);
    } finally {
      emptyBase.dispose();
    }
  });

  test("the same source over the same base hits the same parse", () => {
    expect(parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG)).toBe(
      parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG),
    );
  });

  test("a parse under a registered option domain is not the parse made without it", () => {
    const without = parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG);
    const unregister = registerOptionDomain("rigTestDomain", () => ["a"]);
    try {
      expect(parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG)).not.toBe(
        without,
      );
    } finally {
      unregister();
    }
    expect(parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG)).toBe(without);
  });

  test("a parse under a domain registered again over other members is not the earlier parse", () => {
    const unregisterOne = registerOptionDomain("rigTestDomain", () => ["a"]);
    let one: ReturnType<typeof parsedConfig>;
    try {
      one = parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG);
    } finally {
      unregisterOne();
    }
    const unregisterTwo = registerOptionDomain("rigTestDomain", () => [
      "a",
      "b",
    ]);
    try {
      expect(parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG)).not.toBe(one);
    } finally {
      unregisterTwo();
    }
  });

  test("a compile is shared by its config key", () => {
    const rig = buildRig({ source: SOURCE });
    try {
      const input = compileInputOf(rig.config);
      const key = compileKey(input);
      expect(sharedCompile(key, input)).toBe(sharedCompile(key, input));
    } finally {
      rig.dispose();
    }
  });

  test("a narrowed rig draws the narrowed config under the selection of the whole", () => {
    const source = `{ globals: { palette: 'nord' }, ${SOURCE.slice(1)}`;
    const rig = buildRig({
      source,
      narrow: (whole) => ({
        ...whole,
        globals: { ...whole.globals, palette: "tokyo-night" },
      }),
    });
    const whole = buildRig({ source });
    const pickedIn = (theme: string) => {
      whole.sessionState.set(whole.sessionId, settingNameOf("palette"), theme);
      return whole.draw().frame.rows;
    };
    try {
      const { frame, selection } = rig.draw();
      expect(selection.theme).toMatchObject({ kind: "decided", name: "nord" });
      expect(frame.rows).toEqual(pickedIn("nord"));
      expect(frame.rows).not.toEqual(pickedIn("tokyo-night"));
    } finally {
      rig.dispose();
      whole.dispose();
    }
  });

  test("a draw returns the selection it drew with", () => {
    const rig = buildRig({ source: SOURCE });
    try {
      const unpicked = rig.draw();
      rig.sessionState.set(rig.sessionId, settingNameOf("palette"), "nord");
      const picked = rig.draw();
      expect(picked.selection.theme).toMatchObject({ name: "nord" });
      expect(picked.frame.rows).not.toEqual(unpicked.frame.rows);
      // Handed back in, the returned selection draws the same frame.
      expect(rig.draw({ selection: picked.selection }).frame.rows).toEqual(
        picked.frame.rows,
      );
      expect(rig.draw({ selection: unpicked.selection }).frame.rows).toEqual(
        unpicked.frame.rows,
      );
    } finally {
      rig.dispose();
    }
  });

  test("a draw of a payload naming another session throws", () => {
    const rig = buildRig({ source: SOURCE });
    try {
      expect(() => rig.draw({ payload: { session_id: "other" } })).toThrow(
        /the payload draws session other/,
      );
    } finally {
      rig.dispose();
    }
  });

  test("a rig with nothing stated draws the one segment the source declares", () => {
    const rig = buildRig({ source: SOURCE });
    try {
      expect(textOf(rig.draw().frame)).toContain("hello");
    } finally {
      rig.dispose();
    }
  });
});
