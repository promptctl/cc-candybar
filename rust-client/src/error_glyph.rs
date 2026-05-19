// One-line styled diagnostic glyph emitted on permanent daemon failures.
//
// [LAW:single-enforcer] One formatter per runtime. main.rs's RenderOutcome
// handling calls format_permanent_glyph; nothing else builds this string.
//
// [LAW:one-type-per-behavior] Mirrors src/render/error-glyph.ts byte-for-byte
// for the same logical cause — both runtimes show the same diagnostic so the
// user's experience does not depend on which client is on the hot path. The
// unit test below pins this against the same fixtures the Node side asserts.
//
// Style: red background, white foreground, ANSI reset at end. Constants live
// here rather than imported from server.ts to avoid daemon→client coupling
// (different render contexts; the appearance is policy, not shared state).

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
            format!("daemon rejected request: {}", truncate(msg))
        }
        PermanentCause::RenderFailed(msg) => {
            format!("render failed: {}", truncate(msg))
        }
        PermanentCause::MalformedResponse(msg) => {
            format!("malformed daemon response: {}", truncate(msg))
        }
    }
}

// [LAW:single-enforcer] One sanitize-and-truncate boundary. Daemon error
// strings can contain control characters that break either the glyph's
// single-line property (LF/CR/FF/VT) or its ANSI envelope (ESC at U+001B,
// 8-bit CSI at U+009B, and other Cc-class characters that terminals
// interpret as escape introducers). With BAD_REQUEST messages echoing
// caller-supplied data (e.g. an unknown click verb), that vector is
// reachable without a malicious daemon. `char::is_control()` matches the
// entire Unicode Cc set (C0: 0x00..=0x1F, DEL: 0x7F, C1: 0x80..=0x9F),
// closing both bypass classes — including the 8-bit CSI which
// `is_ascii_control()` would have missed.
//
// [LAW:one-type-per-behavior] Matches the TS mirror at
// src/render/error-glyph.ts (its `isControlChar` predicate covers the
// exact same code-point set). Same single-pass sanitize-and-truncate
// shape, same ellipsis policy.
fn truncate(s: &str) -> String {
    let mut out = String::new();
    let mut count: usize = 0;
    for ch in s.chars() {
        if count == MAX_MESSAGE_LEN {
            // Already at budget — replace the last code point we wrote
            // with the ellipsis so visible length stays at the budget.
            out.pop();
            out.push('…');
            return out;
        }
        let safe = if ch.is_control() { ' ' } else { ch };
        out.push(safe);
        count += 1;
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

    #[test]
    fn render_failed_truncates_long_message() {
        let long = "x".repeat(200);
        let g = format_permanent_glyph(&PermanentCause::RenderFailed(long));
        // 60 chars after the colon-space: 59 x's then an ellipsis.
        assert!(g.contains("render failed: "));
        assert!(g.contains('…'));
        let expected_tail = format!("{}…{TAIL}", "x".repeat(59));
        assert!(
            g.ends_with(&expected_tail),
            "got: {g:?}, expected to end with: {expected_tail:?}"
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
        // No raw control characters in the body — Unicode Cc class is
        // covered by `is_control()` (C0 + DEL + C1). Strip the envelope
        // first because OPEN/TAIL legitimately contain ESC.
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

    // [LAW:one-type-per-behavior] Newline-sanitization coverage symmetric to
    // the TS side. The single-line glyph contract requires no embedded
    // newlines mid-string; both runtimes sanitize \n and \r to spaces at the
    // truncate boundary. This test pins that behavior — a regression that
    // drops the sanitization would let multi-line glyphs reach the
    // statusline and break the layout.
    #[test]
    fn truncate_sanitizes_embedded_newlines() {
        // `\n` and `\r` each become one space, so `\r\n` becomes two spaces.
        // The load-bearing contract is "no embedded newline/CR in the output";
        // the count of inserted spaces is incidental.
        let cases: [(&str, &str); 3] = [
            ("line1\nline2\nline3", "line1 line2 line3"),
            ("line1\rline2\rline3", "line1 line2 line3"),
            ("line1\r\nline2\r\nline3", "line1  line2  line3"),
        ];
        for (input, expected_substr) in cases {
            let g = format_permanent_glyph(&PermanentCause::RenderFailed(input.to_string()));
            // Exactly one trailing newline (the ANSI reset tail).
            assert_eq!(g.matches('\n').count(), 1, "embedded \\n leaked for: {input:?}");
            assert_eq!(g.matches('\r').count(), 0, "embedded \\r leaked for: {input:?}");
            assert!(
                g.contains(expected_substr),
                "expected to contain {expected_substr:?} for input {input:?}, got: {g:?}"
            );
        }
    }

    // [LAW:one-type-per-behavior] Astral-character coverage symmetric to the
    // TS side. Rust's `chars().take(...)` already counts Unicode scalar values;
    // this test pins that contract against the same input the TS test uses, so
    // a future change that drops the `chars()` primitive on either side breaks
    // its own suite rather than silently diverging from the mirror.
    #[test]
    fn render_failed_truncates_at_code_point_boundary() {
        let rockets = "🚀".repeat(100); // 100 code points, 400 UTF-8 bytes
        let g = format_permanent_glyph(&PermanentCause::RenderFailed(rockets));
        // 59 rockets + ellipsis after the "render failed: " label.
        let expected_tail = format!("{}…{TAIL}", "🚀".repeat(59));
        assert!(
            g.ends_with(&expected_tail),
            "got: {g:?}, expected to end with: {expected_tail:?}"
        );
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

    #[test]
    fn glyph_is_single_line() {
        let g = format_permanent_glyph(&PermanentCause::VersionMismatch {
            client_v: CLIENT_V,
            daemon_v: OTHER_V,
        });
        // Exactly one trailing newline; no embedded newlines mid-string.
        assert_eq!(g.matches('\n').count(), 1);
        assert!(g.ends_with('\n'));
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
