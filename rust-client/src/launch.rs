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
// asserting `Command::new(` appears only in this file. [LAW:single-enforcer]
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

// Spawn a detached `node --max-old-space-size=400 <script> daemon`. fds 0/1/2
// are routed to /dev/null. The child is placed in its own session via setsid
// so it isn't reaped when the parent statusline shell exits.
//
// Returns true on successful spawn, false on any setup error (no script, no
// /dev/null, fd clone failure). The caller treats false as "could not
// kick"; the bind() exclusion inside the daemon is the actual singleton
// invariant.
pub fn spawn_node_detached_daemon(node_script: &Path) -> bool {
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
    // Cap V8 old-generation at 400 MB so GC fires before RSS hits the 512 MB
    // hard limit. Mirrors src/daemon/acquire.ts — keep the two in sync.
    cmd.arg(OsString::from("--max-old-space-size=400"))
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
    use std::fs;
    use std::path::{Path, PathBuf};

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
    // file growing a `Command::new(` is a new unaudited spawn site, and — since
    // this module is the only place that knows the two sanctioned lifetimes — a
    // likely frame-outliving helper. Reading the real source keeps the guard
    // from drifting from reality. (Matches `Command::new(` with the paren so the
    // prose `// All Command::new goes through launch.rs` comments don't trip it.)
    #[test]
    fn command_new_lives_only_in_launch_rs() {
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
                fs::read_to_string(p)
                    .expect("read source")
                    .contains("Command::new(")
            })
            .map(|p| p.display().to_string())
            .collect();
        assert!(
            offenders.is_empty(),
            "Command::new( found outside launch.rs: {offenders:?}. Route every \
             spawn through launch.rs (exec_node_replace / \
             spawn_node_detached_daemon). [LAW:single-enforcer]"
        );
    }
}
