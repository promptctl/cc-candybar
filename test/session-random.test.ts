import {
  resolveSessionTheme,
  resolveSessionStyle,
  resolveSessionDisplayStyle,
} from "../src/themes/session-random";
import { SessionState } from "../src/daemon/session-state";
import {
  listAvailableThemes,
  DISPLAY_STYLES,
} from "../src/themes/cascade";
import { STYLE_ORDER } from "../src/themes/default-mapping";

describe("session-random resolvers", () => {
  describe("resolveSessionTheme", () => {
    it("returns the configured concrete theme as-is", () => {
      const ss = new SessionState();
      expect(resolveSessionTheme("s1", "dracula", ss)).toBe("dracula");
      // never wrote anything to sessionState — concrete values pass through.
      expect(ss.get("s1", "theme")).toBeNull();
    });

    it("picks a random concrete theme when config is 'random'", () => {
      const ss = new SessionState();
      const themes = new Set(
        listAvailableThemes().filter((t) => t !== "custom"),
      );
      const picked = resolveSessionTheme("s1", "random", ss);
      expect(picked).not.toBe("random");
      expect(picked).not.toBe("custom");
      expect(themes.has(picked)).toBe(true);
    });

    it("caches the random pick per-session — repeat calls return the same value", () => {
      const ss = new SessionState();
      const first = resolveSessionTheme("s1", "random", ss);
      const second = resolveSessionTheme("s1", "random", ss);
      const third = resolveSessionTheme("s1", "random", ss);
      expect(second).toBe(first);
      expect(third).toBe(first);
    });

    it("different sessions get independent picks (cache key is sessionId)", () => {
      // Drive 50 different sessionIds and verify we see at least 2 distinct
      // theme picks. With ~50 themes, the probability of all-50-sessions
      // picking the same one is (1/N)^49 — vanishingly small.
      const ss = new SessionState();
      const picks = new Set<string>();
      for (let i = 0; i < 50; i++) {
        picks.add(resolveSessionTheme(`s${i}`, "random", ss));
      }
      expect(picks.size).toBeGreaterThan(1);
    });

    it("a click-cycled theme overrides random (sessionState wins)", () => {
      const ss = new SessionState();
      ss.set("s1", "theme", "nord");
      expect(resolveSessionTheme("s1", "random", ss)).toBe("nord");
    });
  });

  describe("resolveSessionStyle", () => {
    it("picks from STYLE_ORDER on 'random' and caches per-session", () => {
      const ss = new SessionState();
      const valid = new Set(STYLE_ORDER);
      const first = resolveSessionStyle("s1", "random", ss);
      expect(valid.has(first)).toBe(true);
      expect(resolveSessionStyle("s1", "random", ss)).toBe(first);
    });

    it("passes concrete styles through unchanged", () => {
      const ss = new SessionState();
      expect(resolveSessionStyle("s1", "muted", ss)).toBe("muted");
    });
  });

  describe("resolveSessionDisplayStyle", () => {
    it("picks from DISPLAY_STYLES on 'random' and caches per-session", () => {
      const ss = new SessionState();
      const valid = new Set(DISPLAY_STYLES);
      const first = resolveSessionDisplayStyle("s1", "random", ss);
      expect(valid.has(first)).toBe(true);
      expect(resolveSessionDisplayStyle("s1", "random", ss)).toBe(first);
    });

    it("returns concrete display styles unchanged", () => {
      const ss = new SessionState();
      expect(resolveSessionDisplayStyle("s1", "capsule", ss)).toBe("capsule");
      expect(resolveSessionDisplayStyle("s1", "powerline", ss)).toBe(
        "powerline",
      );
      expect(resolveSessionDisplayStyle("s1", "minimal", ss)).toBe("minimal");
    });
  });
});
