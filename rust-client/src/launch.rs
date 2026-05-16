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
