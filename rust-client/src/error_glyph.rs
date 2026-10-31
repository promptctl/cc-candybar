// One-line styled diagnostic glyph emitted on permanent daemon failures.
//
// [LAW:single-enforcer] One formatter per runtime. main.rs's RenderOutcome
// handling calls format_permanent_glyph; nothing else builds this string.
//
// [LAW:one-type-per-behavior] Mirrors src/render/error-glyph.ts byte-for-byte
// for the same logical cause — both runtimes show the same diagnostic so the
// user's experience does not depend on which client is on the hot path. The
// unit tests below pin this against the one case table the Node side asserts.
//
// [LAW:one-source-of-truth] The style constants are a literal mirror of the
// canonical TS leaf (src/render/diagnostic-style.ts) — Rust cannot import a
// TS module, so scripts/check-protocol.mjs diffs the mirrored values and
// fails prepublishOnly on drift.

use crate::PermanentCause;

const FG: &str = "\x1b[38;2;255;255;255m";
const BG: &str = "\x1b[48;2;200;40;40m";
const RESET: &str = "\x1b[0m";
const PREFIX: &str = "⚠ cc-candybar: ";

// Long messages from the daemon (parse errors, internal exception strings)
// can be arbitrarily long. The glyph must fit on a single statusline row, so
// truncate to a budget that leaves room for the prefix at typical widths.
const MAX_MESSAGE_LEN: usize = 60;

pub fn format_permanent_glyph(cause: &PermanentCause) -> String {
    format!("{BG}{FG}{PREFIX}{}{RESET}\n", describe(cause))
}

fn describe(cause: &PermanentCause) -> String {
    match cause {
        PermanentCause::VersionMismatch { client_v, daemon_v } => {
            let daemon = if *daemon_v == 0 {
                "unknown".to_string()
            } else {
                format!("v{daemon_v}")
            };
            format!("protocol mismatch (client v{client_v} ≠ daemon {daemon})")
        }
        PermanentCause::BadRequest(msg) => {
            format!("daemon rejected request: {}", truncate(msg, MAX_MESSAGE_LEN))
        }
        PermanentCause::RenderFailed(msg) => {
            format!("render failed: {}", truncate(msg, MAX_MESSAGE_LEN))
        }
        PermanentCause::SwitchedOff(msg) => {
            format!("switched off: {}", truncate(msg, MAX_MESSAGE_LEN))
        }
        PermanentCause::MalformedResponse(msg) => {
            format!("malformed daemon response: {}", truncate(msg, MAX_MESSAGE_LEN))
        }
    }
}

// [LAW:single-enforcer] One sanitize-and-truncate boundary. Daemon error
// strings can contain control characters that break either the glyph's
// single-line property (LF/CR/FF/VT) or its ANSI envelope (ESC at U+001B,
// 8-bit CSI at U+009B, and other Cc-class characters that terminals
// interpret as escape introducers). With BAD_REQUEST messages echoing
// caller-supplied data (e.g. an unknown click verb), that vector is
// reachable without a malicious daemon. `NEUTRALIZED_RANGES` holds the
// entire Unicode Cc set (C0: 0x00..=0x1F, DEL and C1: 0x7F..=0x9F),
// closing both bypass classes — including the 8-bit CSI an ASCII-only
// range would have missed.
//
// Beyond Cc, `neutralized` takes the format controls that hold state past
// the text: the bidi embeddings and overrides with their closer
// (U+202A..=U+202E), the isolates with theirs and the deprecated shaping
// switches (U+2066..=U+206F). An unclosed U+202E would reverse the rest of
// the line.
//
// [LAW:one-type-per-behavior] Matches the TS source at
// src/render/diagnostic-text.ts `sanitizeAndTruncate` byte-for-byte: the
// same collapse-whitespace-runs + trim pass runs between sanitization and
// truncation, so a multi-control input (e.g. "\r\n") yields identical output
// in both runtimes. [LAW:one-source-of-truth] The table and the predicate
// mirror its `NEUTRALIZED_RANGES` and `isControlChar`; scripts/check-protocol.mjs
// holds the tables to one set of code points and both predicates (and their
// one use) to the bare fold, so a change to either runtime's set alone
// fails it. What the whole pass does to a string is behaviour, not a
// literal, so both suites assert the one case table at
// test/fixtures/diagnostic-text-cases.json.
//
// The collapse predicate adds U+FEFF to `char::is_whitespace()`: the TS
// side collapses on JS `\s`, which is Unicode White_Space minus U+0085
// (NEL — Cc, already sanitized to a space on both sides before collapse)
// plus U+FEFF (ZWNBSP). With that one addition the two predicates agree on
// every post-sanitize code point.
const NEUTRALIZED_RANGES: &[(u32, u32)] = &[
    (0x00, 0x1F),
    (0x7F, 0x9F),
    (0x202A, 0x202E),
    (0x2066, 0x206F),
];

fn neutralized(ch: char) -> bool {
    NEUTRALIZED_RANGES.iter().any(|&(lo, hi)| (lo..=hi).contains(&u32::from(ch)))
}

// Sanitize controls to spaces, collapse whitespace runs to one space, trim
// both ends — one pass, mirroring the TS sanitizeText.
fn sanitize(s: &str) -> String {
    let mut sanitized = String::new();
    let mut gap = false;
    for raw in s.chars() {
        let ch = if neutralized(raw) { ' ' } else { raw };
        if ch.is_whitespace() || ch == '\u{FEFF}' {
            // A gap only renders if visible content precedes it (leading
            // runs trim away); a trailing gap never flushes.
            gap = !sanitized.is_empty();
        } else {
            if gap {
                sanitized.push(' ');
                gap = false;
            }
            sanitized.push(ch);
        }
    }
    sanitized
}

// Sanitize, then clip to `budget` visible code points, replacing the last
// one with an ellipsis when over budget so visible length stays at budget.
fn truncate(s: &str, budget: usize) -> String {
    let mut out = String::new();
    for (count, ch) in sanitize(s).chars().enumerate() {
        if count == budget {
            out.pop();
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: &str = "\x1b[48;2;200;40;40m\x1b[38;2;255;255;255m";
    const TAIL: &str = "\x1b[0m\n";

    // [LAW:one-source-of-truth] Fixtures derive both versions from the
    // canonical PROTOCOL_VERSION constant rather than embedding the current
    // numbers as literals. Expected strings are built via format! against
    // the same source. A PROTOCOL_VERSION bump in main.rs flows through here
    // automatically — no test edit required.
    use crate::PROTOCOL_VERSION;
    const CLIENT_V: u32 = PROTOCOL_VERSION;
    const OTHER_V: u32 = PROTOCOL_VERSION + 1;

    #[test]
    fn version_mismatch_known_daemon_v() {
        let g = format_permanent_glyph(&PermanentCause::VersionMismatch {
            client_v: CLIENT_V,
            daemon_v: OTHER_V,
        });
        assert_eq!(
            g,
            format!("{OPEN}⚠ cc-candybar: protocol mismatch (client v{CLIENT_V} ≠ daemon v{OTHER_V}){TAIL}")
        );
    }

    #[test]
    fn version_mismatch_unknown_daemon_v() {
        let g = format_permanent_glyph(&PermanentCause::VersionMismatch {
            client_v: CLIENT_V,
            daemon_v: 0,
        });
        assert!(g.contains(&format!("client v{CLIENT_V} ≠ daemon unknown")));
    }

    #[test]
    fn bad_request_short_message() {
        let g = format_permanent_glyph(&PermanentCause::BadRequest("nope".into()));
        assert_eq!(
            g,
            format!("{OPEN}⚠ cc-candybar: daemon rejected request: nope{TAIL}")
        );
    }

    // [LAW:one-type-per-behavior] ESC + C0 sanitization paired with the TS
    // mirror. A crafted error message containing `\x1b[0m` would otherwise
    // prematurely terminate the glyph's styled envelope; the entire C0
    // range plus DEL must be neutralized at this boundary so the styling
    // contract holds against adversarial input.
    #[test]
    fn truncate_sanitizes_control_chars_c0_del_and_c1() {
        // 0x1B = ESC (7-bit CSI introducer); 0x9B = 8-bit CSI (some
        // terminals interpret this directly without ESC). 0x07 (BEL) and
        // 0x7F (DEL) round out coverage across the Cc class.
        let injection = "verb=danger\u{1B}[0m injected\u{1B}[31m text\u{9B}[0mbypass\u{07}\u{7F} end";
        let g = format_permanent_glyph(&PermanentCause::BadRequest(injection.to_string()));
        // OPEN/TAIL envelope intact.
        assert!(g.starts_with(OPEN), "OPEN envelope broken: {g:?}");
        assert!(g.ends_with(TAIL), "TAIL envelope broken: {g:?}");
        // No raw control characters in the body. std's `is_control()` (the
        // Unicode Cc class: C0 + DEL + C1) is the oracle here, independent of
        // `NEUTRALIZED_RANGES`. Strip the envelope first because OPEN/TAIL
        // legitimately contain ESC.
        let body = &g[OPEN.len()..g.len() - TAIL.len()];
        for ch in body.chars() {
            assert!(
                !ch.is_control(),
                "control character leaked into body: U+{:04X} in {g:?}",
                ch as u32
            );
        }
        // Safe parts of the message survive.
        assert!(body.contains("verb=danger"), "lost safe content: {g:?}");
        assert!(body.contains("injected"), "lost safe content: {g:?}");
        assert!(body.contains("bypass"), "lost safe content after C1: {g:?}");
    }

    // [LAW:one-source-of-truth] [LAW:one-type-per-behavior] The pass's
    // behaviour, from the one table test/diagnostic-text-cases.test.ts asserts
    // against the TS sanitizeText and sanitizeAndTruncate, so a collapse,
    // neutralize or clip rule changed in one runtime fails the other's test.
    const CASES: &str = include_str!("../../test/fixtures/diagnostic-text-cases.json");

    fn cases(key: &str) -> Vec<serde_json::Value> {
        let all: serde_json::Value = serde_json::from_str(CASES).expect("the fixture is JSON");
        let cases = all[key].as_array().expect("the key is a list").clone();
        assert!(!cases.is_empty());
        cases
    }

    #[test]
    fn sanitize_cases() {
        for case in cases("sanitize") {
            let input = case["input"].as_str().expect("input is a string");
            let output = case["output"].as_str().expect("output is a string");
            // Escaped, not raw: the inputs carry ESC, 8-bit CSI and bidi
            // overrides, and a panic message that prints them raw garbles
            // the rest of the report.
            assert_eq!(
                sanitize(input),
                output,
                "input \"{}\"",
                input.escape_default()
            );
        }
    }

    #[test]
    fn clip_cases() {
        for case in cases("clip") {
            let input = case["input"].as_str().expect("input is a string");
            let budget = case["budget"].as_u64().expect("budget is a count") as usize;
            let output = case["output"].as_str().expect("output is a string");
            assert_eq!(
                truncate(input, budget),
                output,
                "input \"{}\" to {budget}",
                input.escape_default()
            );
        }
    }

    // The fixture proves what the clip does to a string; this proves each
    // message path goes through it.
    #[test]
    fn long_messages_are_clipped_to_the_budget() {
        let long = || "x".repeat(MAX_MESSAGE_LEN + 1);
        let clipped = truncate(&long(), MAX_MESSAGE_LEN);
        for (cause, label) in [
            (PermanentCause::BadRequest(long()), "daemon rejected request"),
            (PermanentCause::RenderFailed(long()), "render failed"),
            (PermanentCause::SwitchedOff(long()), "switched off"),
            (PermanentCause::MalformedResponse(long()), "malformed daemon response"),
        ] {
            assert_eq!(
                format_permanent_glyph(&cause),
                format!("{OPEN}⚠ cc-candybar: {label}: {clipped}{TAIL}")
            );
        }
    }

    #[test]
    fn malformed_response_keeps_short_message_unchanged() {
        let g = format_permanent_glyph(&PermanentCause::MalformedResponse(
            "decode response: expected value at line 1 column 1".into(),
        ));
        assert!(g.starts_with(OPEN));
        assert!(g.ends_with(TAIL));
        assert!(g.contains("malformed daemon response: decode response:"));
    }

    // Every cause, and every message-bearing one with a CRLF inside its
    // message: the fixture proves what `sanitize` does to a string, this
    // proves each message path goes through it.
    #[test]
    fn glyph_is_single_line() {
        let msg = || "line1\r\nline2".to_string();
        for cause in [
            PermanentCause::VersionMismatch {
                client_v: CLIENT_V,
                daemon_v: OTHER_V,
            },
            PermanentCause::BadRequest(msg()),
            PermanentCause::RenderFailed(msg()),
            PermanentCause::SwitchedOff(msg()),
            PermanentCause::MalformedResponse(msg()),
        ] {
            let g = format_permanent_glyph(&cause);
            // Exactly one trailing newline; no embedded newlines mid-string.
            assert_eq!(g.matches('\n').count(), 1, "{g:?}");
            assert_eq!(g.matches('\r').count(), 0, "{g:?}");
            assert!(g.ends_with('\n'));
        }
    }

    #[test]
    fn glyph_starts_with_prefix() {
        for cause in [
            PermanentCause::VersionMismatch {
                client_v: CLIENT_V,
                daemon_v: OTHER_V,
            },
            PermanentCause::BadRequest("x".into()),
            PermanentCause::RenderFailed("x".into()),
            PermanentCause::MalformedResponse("x".into()),
        ] {
            let g = format_permanent_glyph(&cause);
            assert!(
                g.starts_with(&format!("{OPEN}⚠ cc-candybar: ")),
                "missing prefix on {cause:?}: {g:?}"
            );
            assert!(g.ends_with(TAIL), "missing reset on {cause:?}: {g:?}");
        }
    }
}
