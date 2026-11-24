// Styled statusline diagnostics for unsuccessful daemon requests.
//
// [LAW:single-enforcer] Each diagnostic has one formatter per runtime.
// main.rs selects the diagnostic from RenderOutcome.
//
// [LAW:one-type-per-behavior] Permanent glyphs mirror src/render/error-glyph.ts
// byte-for-byte. The tests in both runtimes use the same case table.
//
// [LAW:one-source-of-truth] The style constants are a literal mirror of the
// canonical TS leaf (src/render/diagnostic-style.ts) — Rust cannot import a
// TS module, so scripts/check-protocol.mjs diffs the mirrored values and
// fails prepublishOnly on drift.

use crate::{HostBundleRefusal, PermanentCause};
use std::ffi::OsStr;

const FG: &str = "\x1b[38;2;255;255;255m";
const BG: &str = "\x1b[48;2;200;40;40m";
const RESET: &str = "\x1b[0m";
const PREFIX: &str = "⚠ cc-candybar: ";

// [LAW:one-source-of-truth] Mirrored by the Node statusline and check-protocol.
const BOLD: &str = "\x1b[1m";
const WAITING_FOR_DAEMON: &str = "Candybar · waiting for daemon…";
const RENDER_TIMED_OUT: &str = "Candybar timed out";
const DEFAULT_LOG_COMMAND: &str = "tail -n 40 ~/.local/state/cc-candybar/daemon.log";
const XDG_LOG_COMMAND: &str = r#"tail -n 40 "$XDG_STATE_HOME/cc-candybar/daemon.log""#;

pub fn format_waiting_glyph() -> String {
    format!("{BOLD}{WAITING_FOR_DAEMON}{RESET}\n")
}

pub fn format_timeout_glyph(saved_frame: Option<&str>, xdg_state_home: Option<&OsStr>) -> String {
    // [LAW:effects-at-boundaries] Keep the log command runnable without the
    // daemon. The shell expands the user's path when they run it.
    let command = match xdg_state_home {
        Some(value) if !value.is_empty() => XDG_LOG_COMMAND,
        _ => DEFAULT_LOG_COMMAND,
    };
    let frame = saved_frame.unwrap_or_default().trim_end_matches('\n');
    let separator = if frame.is_empty() { "" } else { "\n" };
    format!("{frame}{separator}{BOLD}{RENDER_TIMED_OUT}{RESET} · {command}\n")
}

// Long messages from the daemon (parse errors, internal exception strings)
// can be arbitrarily long. The glyph must fit on a single statusline row, so
// truncate to a budget that leaves room for the prefix at typical widths.
const MAX_MESSAGE_LEN: usize = 60;

// [LAW:one-type-per-behavior] Mirrors formatHostBundleGlyph in
// src/render/error-glyph.ts byte for byte; check-protocol diffs the two words.
// Fixed text, not the refusal's own reason, which goes to stderr.
const HOST_BUNDLE_UNRECORDED: &str = "no host bundle recorded — run: cc-candybar install";
const HOST_BUNDLE_UNUSABLE: &str = "recorded host bundle is unusable — run: cc-candybar install";

pub fn format_host_bundle_glyph(refusal: &HostBundleRefusal) -> String {
    let words = match refusal {
        HostBundleRefusal::Unrecorded => HOST_BUNDLE_UNRECORDED,
        HostBundleRefusal::Unusable(_) => HOST_BUNDLE_UNUSABLE,
    };
    format!("{BG}{FG}{PREFIX}{words}{RESET}\n")
}

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

// [LAW:one-type-per-behavior] Sanitize, then clip to `budget` visible code
// points, the unit the TS clip counts, so the runtimes agree outside ASCII.
// The last one becomes an ellipsis when over budget, so visible length stays
// at budget.
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

    // The bytes test/host-bundle-record.test.ts holds the Node client to.
    #[test]
    fn a_refused_host_start_names_the_install() {
        assert_eq!(
            format_host_bundle_glyph(&HostBundleRefusal::Unrecorded),
            format!("{OPEN}⚠ cc-candybar: no host bundle recorded — run: cc-candybar install{TAIL}")
        );
        assert_eq!(
            format_host_bundle_glyph(&HostBundleRefusal::Unusable("why".into())),
            format!(
                "{OPEN}⚠ cc-candybar: recorded host bundle is unusable — run: cc-candybar install{TAIL}"
            )
        );
    }

    // [LAW:one-source-of-truth] Fixtures derive both versions from the
    // canonical PROTOCOL_VERSION constant rather than embedding the current
    // numbers as literals. Expected strings are built via format! against
    // the same source. A PROTOCOL_VERSION bump in main.rs flows through here
    // automatically — no test edit required.
    use crate::PROTOCOL_VERSION;
    const CLIENT_V: u32 = PROTOCOL_VERSION;
    const OTHER_V: u32 = PROTOCOL_VERSION + 1;

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
    // against the TS sanitizeText, sanitizeAndTruncate and formatPermanentGlyph,
    // so a collapse, neutralize, clip or label rule changed in one runtime fails
    // the other's test.
    const CASES: &str = include_str!("../../test/fixtures/diagnostic-text-cases.json");

    fn cases(key: &str) -> Vec<serde_json::Value> {
        let mut all: serde_json::Value = serde_json::from_str(CASES).expect("the fixture is JSON");
        let serde_json::Value::Array(cases) = all[key].take() else {
            panic!("{key} is a list");
        };
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

    #[test]
    fn glyph_cases() {
        for case in cases("glyph") {
            let outcome = &case["outcome"];
            let version = |key: &str| outcome[key].as_u64().expect("a version is a count") as u32;
            let message = || outcome["message"].as_str().expect("message is a string").to_string();
            let output = case["output"].as_str().expect("output is a string");
            let cause = match outcome["cause"].as_str().expect("cause is a string") {
                "version_mismatch" => PermanentCause::VersionMismatch {
                    client_v: version("clientV"),
                    daemon_v: version("daemonV"),
                },
                "bad_request" => PermanentCause::BadRequest(message()),
                "render_failed" => PermanentCause::RenderFailed(message()),
                "switched_off" => PermanentCause::SwitchedOff(message()),
                "malformed_response" => PermanentCause::MalformedResponse(message()),
                other => panic!("no permanent cause {other}"),
            };
            assert_eq!(format_permanent_glyph(&cause), format!("{OPEN}{output}{TAIL}"));
        }
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
