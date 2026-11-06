import { MAIN_NAME } from "../src/daemon/home";
// What the rig promises a test that builds it: the parse and the compile of one
// source are shared between rigs, and everything that holds a subscription or a
// session's picks is a rig's own.
import { linkSigner } from "../src/click/link-signer";
import { DEFAULT_DSL_CONFIG } from "../src/config/default-dsl-config";
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

  test("a different source, base, or palette set is a different parse", () => {
    const palettes = new Set(["tokyo-night"]);
    const base = parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, palettes);
    const other = parsedConfig(
      "<test>",
      SOURCE,
      DEFAULT_DSL_CONFIG,
      new Set(["tokyo-night", "nord"]),
    );
    const emptyBase = buildRig({ source: SOURCE });
    try {
      expect(other).not.toBe(base);
      expect(emptyBase.config).not.toBe(base);
    } finally {
      emptyBase.dispose();
    }
  });

  test("a palette set built afresh with the same names hits the same parse", () => {
    const names = ["tokyo-night", "nord"];
    expect(
      parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, new Set(names)),
    ).toBe(
      parsedConfig(
        "<test>",
        SOURCE,
        DEFAULT_DSL_CONFIG,
        new Set([...names].reverse()),
      ),
    );
  });

  test("a parse under a registered option domain is not the parse made without it", () => {
    const palettes = new Set(["tokyo-night"]);
    const without = parsedConfig(
      "<test>",
      SOURCE,
      DEFAULT_DSL_CONFIG,
      palettes,
    );
    const unregister = registerOptionDomain("rigTestDomain", () => ["a"]);
    try {
      expect(
        parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, palettes),
      ).not.toBe(without);
    } finally {
      unregister();
    }
    expect(parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, palettes)).toBe(
      without,
    );
  });

  test("a parse under a domain registered again over other members is not the earlier parse", () => {
    const palettes = new Set(["tokyo-night"]);
    const unregisterOne = registerOptionDomain("rigTestDomain", () => ["a"]);
    let one: ReturnType<typeof parsedConfig>;
    try {
      one = parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, palettes);
    } finally {
      unregisterOne();
    }
    const unregisterTwo = registerOptionDomain("rigTestDomain", () => [
      "a",
      "b",
    ]);
    try {
      expect(
        parsedConfig("<test>", SOURCE, DEFAULT_DSL_CONFIG, palettes),
      ).not.toBe(one);
    } finally {
      unregisterTwo();
    }
  });

  test("a compile is shared by renderer links: one renderer's compile is not another's", () => {
    const rig = buildRig({ source: SOURCE });
    try {
      const input = compileInputOf(rig.config);
      const one = { to: MAIN_NAME, signer: linkSigner(Buffer.alloc(32, 1)) };
      const two = { to: MAIN_NAME, signer: linkSigner(Buffer.alloc(32, 2)) };
      const key = compileKey(input);
      expect(sharedCompile(one)(key, input)).toBe(
        sharedCompile(one)(key, input),
      );
      expect(sharedCompile(two)(key, input)).not.toBe(
        sharedCompile(one)(key, input),
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
