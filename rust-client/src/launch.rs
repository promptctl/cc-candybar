// Single process-launch boundary for the Rust client (kz8.2).
//
// [LAW:single-enforcer] One file owns `std::process::Command` in the Rust
// runtime. Two operations live here because they are different acts, not
// flags on one act:
//
//   - `exec_node_replace(argv)` — execvp(2)-style: the current process image
//     is replaced by node. Returns only on error.
//   - `spawn_node_detached_daemon(script)` — fork(2) + setsid(2) detached
//     child that outlives the parent. Caller does not wait.
//
// [LAW:one-type-per-behavior] Detaching is its own behavior (different
// post-conditions, different fd handling, different lifetime), not a flag
// on "run a command." Two functions, not one with a `detached: bool`.
//
// [LAW:types-are-the-program] (kz8.6) This closed two-operation surface *is*
// the "no helper outlives a render frame" guarantee. The client's third
// constraint — a stale child must never survive the frame that spawned it —
// holds by construction, not by review vigilance: there is deliberately NO
// general spawn-and-continue operation here. `exec_node_replace` consumes the
// process image (nothing survives the frame; the frame becomes node), and
// `spawn_node_detached_daemon` is the single sanctioned orphan (the
// daemon-handoff escape hatch, the *only* spawn permitted to outlive its
// caller). A future regression that wanted to spawn an unwaited helper would
// have to add a third operation — which the guard test below forbids by
// asserting no Command construction (a `Command::new(` call or a
// `process::Command` import under any alias) appears outside this file.
// [LAW:single-enforcer]
//
// No metering: the client process is single-frame and short-lived. Daemon
// metering of subprocess churn lives in the Node runtime.

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

pub fn exec_node_replace(node_script: &Path, argv_tail: &[String]) -> io::Error {
    let mut cmd = Command::new("node");
    cmd.arg(node_script.as_os_str());
    for a in argv_tail.iter() {
        cmd.arg(a);
    }
    // execvp replaces the current process image. Returns only on error.
    cmd.exec()
}

// [LAW:one-source-of-truth] Mirror of src/daemon/limits.ts — the daemon's ONE
// memory budget, from which both its RSS backstop (daemon-side, graceful) and
// the V8 old-space cap this spawner passes (hard: SIGABRT below every JS
// handler, no log line) derive. The cap is HEAP_CAP_OVER_RSS × the budget so
// the graceful path always fires first. scripts/check-protocol.mjs fails the
// build if these three drift from the TS side.
const RSS_LIMIT_ENV: &str = "CC_CANDYBAR_RSS_LIMIT_MB";
const DEFAULT_RSS_LIMIT_MB: u64 = 512;
const HEAP_CAP_OVER_RSS: u64 = 2;

// [LAW:parse-dont-validate] Mirror of limits.ts rssLimitMb/heapCapMb: absent →
// default; a positive integer → that; malformed → Err. The daemon itself would
// refuse to boot on the same malformed value, so spawning it would only add a
// crash-loop on top of the operator error. [LAW:no-silent-failure]
//
// [LAW:one-source-of-truth] The grammar is the TS grammar verbatim — ASCII
// digits only, > 0, within JS's safe-integer range (2^53 − 1, the bound
// `Number.isSafeInteger` applies on the daemon side) — so the spawner and the
// daemon it spawns accept and reject the same values. `str::parse::<u64>`
// alone would admit a leading `+` the daemon refuses, and a `u64` upper bound
// would admit a value the daemon refuses as unsafe.
const JS_MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

pub fn heap_cap_mb(raw: Option<&str>) -> Result<u64, String> {
    let reject = |s: &str| format!("{RSS_LIMIT_ENV} must be a positive integer (MB), got {s:?}");
    let mb = match raw {
        None => DEFAULT_RSS_LIMIT_MB,
        Some(s) => {
            let well_formed = !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
            match s.parse::<u64>() {
                Ok(v) if well_formed && v > 0 && v <= JS_MAX_SAFE_INTEGER => v,
                _ => return Err(reject(s)),
            }
        }
    };
    // Cannot overflow: mb ≤ 2^53 − 1, so the product is < 2^54.
    Ok(mb * HEAP_CAP_OVER_RSS)
}

// Spawn a detached `node --max-old-space-size=<heap_cap_mb> <script> daemon`.
// fds 0/1/2 are routed to /dev/null. The child is placed in its own session
// via setsid so it isn't reaped when the parent statusline shell exits.
//
// Returns true on successful spawn, false on any setup error (no script, no
// /dev/null, fd clone failure, malformed memory budget). The caller treats
// false as "could not kick"; the bind() exclusion inside the daemon is the
// actual singleton invariant.
pub fn spawn_node_detached_daemon(node_script: &Path) -> bool {
    // [LAW:no-silent-failure] `var` distinguishes absent from present-but-not-
    // UTF-8; `.ok()` would have collapsed a non-UTF-8 value into "unset" and
    // spawned a daemon at the default budget the operator did not ask for.
    let raw = match std::env::var(RSS_LIMIT_ENV) {
        Ok(s) => Some(s),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(os)) => {
            eprintln!("cc-candybar: not spawning daemon — {RSS_LIMIT_ENV} is not UTF-8: {os:?}");
            return false;
        }
    };
    let heap_cap = match heap_cap_mb(raw.as_deref()) {
        Ok(mb) => mb,
        Err(msg) => {
            eprintln!("cc-candybar: not spawning daemon — {msg}");
            return false;
        }
    };
    let dev_null = match File::options().read(true).write(true).open("/dev/null") {
        Ok(f) => f,
        Err(_) => return false,
    };
    let stdin_fd = match dev_null.try_clone() {
        Ok(f) => Stdio::from(f),
        Err(_) => return false,
    };
    let stdout_fd = match dev_null.try_clone() {
        Ok(f) => Stdio::from(f),
        Err(_) => return false,
    };
    let stderr_fd = Stdio::from(dev_null);

    let mut cmd = Command::new("node");
    cmd.arg(OsString::from(format!("--max-old-space-size={heap_cap}")))
        .arg(node_script.as_os_str())
        .arg("daemon")
        .stdin(stdin_fd)
        .stdout(stdout_fd)
        .stderr(stderr_fd);
    unsafe {
        cmd.pre_exec(|| {
            // New session — detach from this process group so the daemon
            // outlives us and isn't reaped when statusline shells exit.
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().is_ok()
}

#[cfg(test)]
mod tests {
    use super::heap_cap_mb;
    use std::fs;
    use std::path::{Path, PathBuf};

    // [LAW:behavior-not-structure] The contract: the cap is twice the budget,
    // the budget defaults when unset, and garbage is refused rather than
    // silently defaulted. The exact numbers are pinned TS↔Rust by
    // scripts/check-protocol.mjs, not here.
    //
    // ACCEPT and REJECT are the SAME tables test/daemon-limits.test.ts runs
    // against rssLimitMb/heapCapMb — one grammar, pinned from both sides by
    // scripts/check-protocol.mjs, which diffs the two lists.
    const ACCEPT: &[(&str, u64)] = &[("1024", 1024), ("007", 7)];
    const REJECT: &[&str] = &[
        "",
        " ",
        " 300 ",
        "0",
        "-5",
        "+10",
        "abc",
        "1.5",
        "512MB",
        "1_000",
        "١٢",
        "9007199254740992", // 2^53: past the safe-integer range
        "99999999999999999999",
    ];

    #[test]
    fn heap_cap_derives_from_rss_budget() {
        assert_eq!(heap_cap_mb(None), Ok(512 * 2));
        for (raw, mb) in ACCEPT {
            assert_eq!(heap_cap_mb(Some(raw)), Ok(mb * 2), "{raw:?}");
        }
        for garbage in REJECT {
            assert!(heap_cap_mb(Some(garbage)).is_err(), "{garbage:?} accepted");
        }
    }

    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).expect("read src dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                rs_files(&path, out);
            } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                out.push(path);
            }
        }
    }

    // [LAW:single-enforcer] (kz8.6) The Rust mirror of the ESLint
    // no-restricted-imports guard that pins child_process to src/proc/launch.ts.
    // `std::process::Command` may be constructed only in launch.rs; any other
    // file growing a Command construction is a new unaudited spawn site, and —
    // since this module is the only place that knows the two sanctioned
    // lifetimes — a likely frame-outliving helper. Reading the real source
    // keeps the guard from drifting from reality.
    #[test]
    fn command_construction_lives_only_in_launch_rs() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // Exact path, not basename: a future `src/foo/launch.rs` must NOT be
        // exempt — only *this* file owns Command construction.
        let this_file = src_dir.join("launch.rs");
        let mut files = Vec::new();
        rs_files(&src_dir, &mut files);
        let offenders: Vec<String> = files
            .iter()
            .filter(|p| **p != this_file)
            .filter(|p| {
                let body = fs::read_to_string(p).expect("read source");
                // `Command::new(` catches every direct construction: the
                // qualified spellings (`std::process::Command::new(`,
                // `process::Command::new(`) all *end in* this substring, so an
                // unanchored match covers them.
                if body.contains("Command::new(") {
                    return true;
                }
                // `process::Command` additionally catches a `use` that pulls the
                // type into scope under any alias (`use std::process::Command as
                // Cmd;` then `Cmd::new(`) — the one construction route the
                // call-site match alone would miss. Require a non-identifier
                // char right after `Command` so this does NOT match the
                // unrelated `std::os::unix::process::CommandExt`.
                let needle = "process::Command";
                body.match_indices(needle).any(|(i, _)| {
                    let next = body[i + needle.len()..].chars().next();
                    !matches!(next, Some(c) if c.is_alphanumeric() || c == '_')
                })
            })
            .map(|p| p.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "Command construction found outside launch.rs: {offenders:?}. Route \
             every spawn through launch.rs (exec_node_replace / \
             spawn_node_detached_daemon). [LAW:single-enforcer]"
        );
    }
}
