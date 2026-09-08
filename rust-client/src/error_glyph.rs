// One-line styled diagnostic glyph emitted on permanent daemon failures.
// [LAW:single-enforcer] One formatter per runtime. [LAW:one-type-per-behavior] Mirrors src/render/error-glyph.ts byte-for-byte, so the diagnostic never depends on which client ran.
// [LAW:one-source-of-truth] The style constants mirror src/render/diagnostic-style.ts; check-protocol.mjs fails prepublishOnly on drift.

use crate::PermanentCause;

const FG: &str = "\x1b[38;2;255;255;255m";
const BG: &str = "\x1b[48;2;200;40;40m";
const RESET: &str = "\x1b[0m";
const PREFIX: &str = "⚠ cc-candybar: ";

// The glyph must fit one statusline row, with room for the prefix at typical widths.
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

// [LAW:single-enforcer] One sanitize-and-truncate boundary; `is_control()` covers the whole Cc set (C0, DEL, C1), closing the 8-bit-CSI bypass `is_ascii_control()` would miss.
// [LAW:one-type-per-behavior] Matches src/render/diagnostic-text.ts; the collapse predicate adds U+FEFF so the two predicates agree on every post-sanitize code point.
fn truncate(s: &str) -> String {
    let mut sanitized = String::new();
    let mut gap = false;
    for raw in s.chars() {
        let ch = if raw.is_control() { ' ' } else { raw };
        if ch.is_whitespace() || ch == '\u{FEFF}' {
            // A gap renders only if visible content precedes it; a trailing gap never flushes.
            gap = !sanitized.is_empty();
        } else {
            if gap {
                sanitized.push(' ');
                gap = false;
            }
            sanitized.push(ch);
        }
    }
    // Replacing the last code point with the ellipsis keeps visible length at budget.
    let mut out = String::new();
    for (count, ch) in sanitized.chars().enumerate() {
        if count == MAX_MESSAGE_LEN {
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

    // [LAW:one-source-of-truth] Derived from PROTOCOL_VERSION, so a bump needs no test edit.
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
        assert!(g.contains("render failed: "));
        assert!(g.contains('…'));
        let expected_tail = format!("{}…{TAIL}", "x".repeat(59));
        assert!(
            g.ends_with(&expected_tail),
            "got: {g:?}, expected to end with: {expected_tail:?}"
        );
    }

    // [LAW:one-type-per-behavior] A crafted `\x1b[0m` would terminate the glyph's styled envelope, so the whole C0 range plus DEL is neutralized here.
    #[test]
    fn truncate_sanitizes_control_chars_c0_del_and_c1() {
        // 0x1B ESC, 0x9B 8-bit CSI, 0x07 BEL, 0x7F DEL — coverage across the Cc class.
        let injection = "verb=danger\u{1B}[0m injected\u{1B}[31m text\u{9B}[0mbypass\u{07}\u{7F} end";
        let g = format_permanent_glyph(&PermanentCause::BadRequest(injection.to_string()));
        assert!(g.starts_with(OPEN), "OPEN envelope broken: {g:?}");
        assert!(g.ends_with(TAIL), "TAIL envelope broken: {g:?}");
        // Strip the envelope first: OPEN/TAIL legitimately contain ESC.
        let body = &g[OPEN.len()..g.len() - TAIL.len()];
        for ch in body.chars() {
            assert!(
                !ch.is_control(),
                "control character leaked into body: U+{:04X} in {g:?}",
                ch as u32
            );
        }
        assert!(body.contains("verb=danger"), "lost safe content: {g:?}");
        assert!(body.contains("injected"), "lost safe content: {g:?}");
        assert!(body.contains("bypass"), "lost safe content after C1: {g:?}");
    }

    // [LAW:one-type-per-behavior] Both runtimes collapse a "\r\n" break to exactly one space — byte-identical output, not merely "no newline leaked".
    #[test]
    fn truncate_sanitizes_embedded_newlines() {
        let cases: [(&str, &str); 3] = [
            ("line1\nline2\nline3", "line1 line2 line3"),
            ("line1\rline2\rline3", "line1 line2 line3"),
            ("line1\r\nline2\r\nline3", "line1 line2 line3"),
        ];
        for (input, expected_substr) in cases {
            let g = format_permanent_glyph(&PermanentCause::RenderFailed(input.to_string()));
            assert_eq!(g.matches('\n').count(), 1, "embedded \\n leaked for: {input:?}");
            assert_eq!(g.matches('\r').count(), 0, "embedded \\r leaked for: {input:?}");
            assert!(
                g.contains(expected_substr),
                "expected to contain {expected_substr:?} for input {input:?}, got: {g:?}"
            );
        }
    }

    // [LAW:one-type-per-behavior] The exact fixtures test/diagnostic-text.test.ts pins, so a divergence breaks its own suite.
    #[test]
    fn truncate_collapses_whitespace_runs_and_trims() {
        assert_eq!(truncate("a    b\n\n\nc"), "a b c");
        assert_eq!(truncate("  hello  "), "hello");
        assert_eq!(truncate("\n\nhello\n\n"), "hello");
        // U+FEFF collapses like whitespace — JS `\s` includes it, so byte parity requires it here.
        assert_eq!(truncate("a\u{FEFF} b"), "a b");
    }

    // [LAW:one-type-per-behavior] Pins truncation at a code-point (not byte) boundary, against the same input the TS test uses.
    #[test]
    fn render_failed_truncates_at_code_point_boundary() {
        let rockets = "🚀".repeat(100); // 100 code points, 400 UTF-8 bytes
        let g = format_permanent_glyph(&PermanentCause::RenderFailed(rockets));
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
