// [LAW:single-enforcer] One file owns `std::process::Command` in the Rust runtime.
// [LAW:one-type-per-behavior] Detaching is its own behavior, not a flag on "run a
// command". [LAW:types-are-the-program] There is deliberately NO general
// spawn-and-continue operation, so no helper can outlive a render frame.

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
    cmd.exec()
}

// [LAW:one-source-of-truth] Mirror of src/daemon/limits.ts; cap above the RSS budget.
const RSS_LIMIT_ENV: &str = "CC_CANDYBAR_RSS_LIMIT_MB";
const DEFAULT_RSS_LIMIT_MB: u64 = 512;
const HEAP_CAP_OVER_RSS: u64 = 2;

// [LAW:parse-dont-validate][LAW:no-silent-failure][LAW:one-source-of-truth] The TS
// grammar verbatim — ASCII digits, > 0, within JS's safe-integer range.
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

// False means "could not kick"; the daemon's own bind() exclusion is the singleton.
pub fn spawn_node_detached_daemon(node_script: &Path) -> bool {
    // [LAW:no-silent-failure] `var` distinguishes absent from present-but-not-UTF-8.
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

    // [LAW:behavior-not-structure] The same tables test/daemon-limits.test.ts runs
    // against rssLimitMb/heapCapMb; scripts/check-protocol.mjs diffs the two lists.
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

    // [LAW:single-enforcer] Rust mirror of the ESLint no-restricted-imports guard:
    // `std::process::Command` may be constructed only in launch.rs.
    #[test]
    fn command_construction_lives_only_in_launch_rs() {
        let src_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        // Exact path, not basename: a future `src/foo/launch.rs` must NOT be exempt.
        let this_file = src_dir.join("launch.rs");
        let mut files = Vec::new();
        rs_files(&src_dir, &mut files);
        let offenders: Vec<String> = files
            .iter()
            .filter(|p| **p != this_file)
            .filter(|p| {
                let body = fs::read_to_string(p).expect("read source");
                // Qualified spellings all end in this substring; unanchored match covers them.
                if body.contains("Command::new(") {
                    return true;
                }
                // Also catches an aliased `use`; the trailing char excludes `CommandExt`.
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
