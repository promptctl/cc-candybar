// Native render-path client for cc-candybar.
//
// Replaces `node dist/index.mjs` on the statusline hot path. Subcommands
// (install, daemon, daemon-stats, url-handle, install-url-handler, --help)
// transparently exec the Node fallback so this binary stays minimal.
//
// Wire format mirrors src/daemon/protocol.ts:
//   - 4-byte big-endian length prefix
//   - UTF-8 JSON body
//   - 16 MiB cap
// The protocol version is in the PROTOCOL_VERSION const below — single
// source of truth, kept in lockstep with src/daemon/protocol.ts via
// scripts/check-protocol.mjs.
//
// Timeouts mirror src/daemon/client.ts: 50ms connect, 150ms total.
//
// On any daemon failure: obtain_daemon_kick() runs a fire-and-forget acquire
// gated by an existence-as-lock spawn.lock file (open with O_CREAT | O_EXCL,
// release by unlink — same primitive Node uses in src/daemon/acquire.ts so
// the two runtimes interoperate). The actual one-daemon invariant is
// enforced by atomic bind() inside the daemon (see
// src/daemon/server.ts:bindOrAttachAndExit); the spawn.lock is the
// thundering-herd optimization that prevents N clients from each forking a
// Node process when one suffices. Mirrors src/daemon/acquire.ts.

mod launch;

use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::io::FromRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u32 = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(50);
const TOTAL_BUDGET: Duration = Duration::from_millis(150);
const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

const SUBCOMMANDS: &[&str] = &[
    "install",
    "install-url-handler",
    "url-handle",
    "daemon",
    "daemon-stats",
];

fn main() {
    let argv: Vec<String> = env::args().collect();

    if should_dispatch_to_node(&argv) {
        exec_node_fallback(&argv);
        eprintln!("cc-candybar: failed to exec node fallback");
        std::process::exit(1);
    }

    // Parse stdin once up-front. We need session_id for the per-session
    // last-render cache (daemon-miss fallback shows stale data, not blank).
    let parsed = match parse_stdin() {
        Ok(p) => p,
        Err(BadInput::Msg(msg)) => {
            eprintln!("cc-candybar: {msg}");
            std::process::exit(1);
        }
    };

    // [LAW:types-are-the-program] The render outcome carries its own
    // recovery semantics. Three branches:
    //   Ok        — print and persist for stale-fallback.
    //   Transient — kick a fresh daemon, emit stale frame or "\n".
    //   Permanent — daemon refused our request; respawning will not help.
    //               Emit a diagnostic and do NOT kick. Mirrors the Node
    //               caller in src/index.ts. Kicking on every failure was
    //               the load-bearing half of the 452-corpse spiral (kz8.5).
    match render(&argv, &parsed.hook_data) {
        RenderOutcome::Ok(output) => {
            let _ = io::stdout().write_all(output.as_bytes());
            // Persist for the next daemon-miss. Best-effort: if disk is
            // full or perms are wrong, the user just gets a blink later
            // instead of a stale frame — same as today's behavior.
            if let Some(sid) = parsed.session_id.as_deref() {
                let _ = write_last_render(sid, &output);
            }
            std::process::exit(0);
        }
        RenderOutcome::Transient(_cause) => {
            obtain_daemon_kick();
            let stale = parsed
                .session_id
                .as_deref()
                .and_then(|sid| read_last_render(sid));
            let bytes = stale.as_deref().map(str::as_bytes).unwrap_or(b"\n");
            let _ = io::stdout().write_all(bytes);
            std::process::exit(0);
        }
        RenderOutcome::Permanent(_cause) => {
            // chunk 2 will emit a styled glyph naming the cause. For now,
            // a bare newline keeps the statusline non-blank. Critically:
            // no obtain_daemon_kick() — that's what loops on VERSION_MISMATCH.
            let _ = io::stdout().write_all(b"\n");
            std::process::exit(0);
        }
    }
}

struct ParsedInput {
    hook_data: serde_json::Value,
    session_id: Option<String>,
}

fn parse_stdin() -> Result<ParsedInput, BadInput> {
    let mut buf = Vec::with_capacity(4096);
    io::stdin()
        .read_to_end(&mut buf)
        .map_err(|e| BadInput::Msg(format!("stdin read: {e}")))?;
    if buf.is_empty() {
        return Err(BadInput::Msg(
            "no input on stdin (this tool reads hook data from Claude Code)".into(),
        ));
    }
    let hook_data: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| BadInput::Msg(format!("stdin not JSON: {e}")))?;
    let session_id = hook_data
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Ok(ParsedInput {
        hook_data,
        session_id,
    })
}

// --- argv dispatch -------------------------------------------------------

fn should_dispatch_to_node(argv: &[String]) -> bool {
    // --help / -h anywhere → Node prints help.
    if argv.iter().any(|a| a == "--help" || a == "-h") {
        return true;
    }
    // First non-binary arg is a subcommand → Node handles it.
    if let Some(first) = argv.get(1) {
        if SUBCOMMANDS.iter().any(|s| s == first) {
            return true;
        }
    }
    // Stdin is a TTY → Node prints the "needs input from Claude Code"
    // error. We mirror the check rather than reproducing the message.
    if unsafe { libc::isatty(0) } == 1 {
        return true;
    }
    false
}

fn exec_node_fallback(argv: &[String]) {
    let script = match dist_index_path() {
        Some(p) => p,
        None => {
            eprintln!("cc-candybar: cannot locate dist/index.mjs");
            std::process::exit(1);
        }
    };
    // [LAW:single-enforcer] All Command::new goes through launch.rs.
    let argv_tail: Vec<String> = argv.iter().skip(1).cloned().collect();
    let err = launch::exec_node_replace(&script, &argv_tail);
    eprintln!("cc-candybar: exec node failed: {err}");
}

fn dist_index_path() -> Option<PathBuf> {
    // <binary_dir>/../dist/index.mjs — works for both the in-package layout
    // (bin/cc-candybar → ../dist/index.mjs) and the platform-package layout
    // since the binary placed by postinstall lives at the same relative path.
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("..").join("dist").join("index.mjs"))
}

// --- render path ---------------------------------------------------------

// [LAW:types-are-the-program] Mirrors ClientOutcome in src/daemon/client.ts.
// The variant *is* the recovery decision: Transient warrants a kick;
// Permanent does not. Conflating them — which is what the previous shape
// did, returning Result<String, _> with everything bucketed into a single
// failure tag — was the load-bearing half of the 452-corpse spiral (kz8.5).
#[derive(Debug)]
#[allow(dead_code)] // payload fields read only via Debug
pub enum RenderOutcome {
    Ok(String),
    Transient(TransientCause),
    Permanent(PermanentCause),
}

#[derive(Debug)]
#[allow(dead_code)] // payload strings read only via Debug
pub enum TransientCause {
    Unreachable(String),
    Timeout,
    Io(String),
}

#[derive(Debug)]
#[allow(dead_code)] // payload fields read only via Debug
pub enum PermanentCause {
    VersionMismatch { client_v: u32, daemon_v: u32 },
    BadRequest(String),
    RenderFailed(String),
    MalformedResponse(String),
}

// BadInput is a startup-time parse failure on stdin — it is *not* a render
// outcome. It exits 1 in main() before any wire activity happens.
#[derive(Debug)]
enum BadInput {
    Msg(String),
}

fn render(argv: &[String], hook_data: &serde_json::Value) -> RenderOutcome {
    let deadline = Instant::now() + TOTAL_BUDGET;
    let cwd = match env::current_dir() {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(e) => return RenderOutcome::Transient(TransientCause::Io(e.to_string())),
    };
    // [LAW:single-enforcer] Terminal width is captured here, in the client's
    // live shell context, then trusted by the daemon. The daemon's own env
    // reflects whichever shell launched it, not the active terminal.
    let term_cols = detect_term_cols();

    let mut request = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "kind": "render",
        "hookData": hook_data,
        "args": argv,
        "cwd": cwd,
    });
    if let Some(cols) = term_cols {
        request["termCols"] = serde_json::Value::from(cols);
    }
    let body = match serde_json::to_vec(&request) {
        Ok(b) => b,
        // Encoding our own request failed — this is a programming error
        // (non-serializable hook_data), not a daemon problem. Treat as
        // Permanent so we don't loop on it.
        Err(e) => {
            return RenderOutcome::Permanent(PermanentCause::MalformedResponse(format!(
                "encode request: {e}"
            )));
        }
    };

    let socket = socket_path();
    let mut sock = match connect_with_timeout(&socket, CONNECT_TIMEOUT) {
        Ok(s) => s,
        Err(e) => return classify_io_error(e),
    };

    if let Err(e) = remaining_or_io(deadline).and_then(|d| sock.set_write_timeout(Some(d))) {
        return classify_io_error(e);
    }
    if let Err(e) = write_frame(&mut sock, &body) {
        return classify_io_error(e);
    }

    if let Err(e) = remaining_or_io(deadline).and_then(|d| sock.set_read_timeout(Some(d))) {
        return classify_io_error(e);
    }
    let resp_body = match read_frame(&mut sock) {
        Ok(b) => b,
        Err(e) => return classify_io_error(e),
    };

    let resp: serde_json::Value = match serde_json::from_slice(&resp_body) {
        Ok(v) => v,
        Err(e) => {
            return RenderOutcome::Permanent(PermanentCause::MalformedResponse(format!(
                "decode response: {e}"
            )));
        }
    };

    interpret_response(resp)
}

// [LAW:types-are-the-program] One place that turns a wire-level response
// into a typed outcome — mirrors interpretResponse() in src/daemon/client.ts.
// Every non-ok wire code maps to exactly one variant; TIMEOUT is the only
// one that becomes Transient because it is the only one a respawn can cure.
fn interpret_response(resp: serde_json::Value) -> RenderOutcome {
    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        return match resp.get("output").and_then(|v| v.as_str()) {
            Some(output) => RenderOutcome::Ok(output.to_string()),
            None => RenderOutcome::Permanent(PermanentCause::MalformedResponse(
                "ok response missing output".into(),
            )),
        };
    }
    let code = resp
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("UNKNOWN");
    let msg = resp
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("(no error message)")
        .to_string();
    match code {
        "VERSION_MISMATCH" => {
            // Older daemons may not echo daemonV; fall back to 0 so the
            // glyph (chunk 2) can render "client v3 ≠ daemon v?" rather
            // than parse the human error string.
            let daemon_v = resp
                .get("daemonV")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32)
                .unwrap_or(0);
            RenderOutcome::Permanent(PermanentCause::VersionMismatch {
                client_v: PROTOCOL_VERSION,
                daemon_v,
            })
        }
        "TIMEOUT" => RenderOutcome::Transient(TransientCause::Timeout),
        "BAD_REQUEST" => RenderOutcome::Permanent(PermanentCause::BadRequest(msg)),
        "RENDER_FAILED" => RenderOutcome::Permanent(PermanentCause::RenderFailed(msg)),
        _ => RenderOutcome::Permanent(PermanentCause::MalformedResponse(format!(
            "unknown error code: {code}"
        ))),
    }
}

// [LAW:no-defensive-null-guards] Connect/read/write errors come from the
// trust boundary with the kernel. Each known errno kind maps to a typed
// cause; unknown kinds fall through to Io. We never silently bucket
// these into a stringified failure that loses the recovery signal.
fn classify_io_error(e: io::Error) -> RenderOutcome {
    use io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused | NotFound => {
            RenderOutcome::Transient(TransientCause::Unreachable(e.to_string()))
        }
        TimedOut | WouldBlock => RenderOutcome::Transient(TransientCause::Timeout),
        _ => RenderOutcome::Transient(TransientCause::Io(e.to_string())),
    }
}

// Returns the remaining time before the deadline as a Duration, or an
// io::Error with kind TimedOut so the caller's classify_io_error converts
// it correctly. Replaces the old `remaining()` which used a custom error
// type; this shape lets the deadline check share the IO error path.
fn remaining_or_io(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "deadline exceeded"))
}

// Pure terminal-width capture — no subprocess, no shell-out. Tries the env
// first (set by Bash/Zsh and propagated to hook commands by Claude Code) and
// falls back to TIOCGWINSZ on stderr (typically a TTY when run as a Claude
// hook — stdin is the hook JSON pipe). Returns None when neither source has
// a usable value; the daemon will treat absence as "unknown width" and let
// its own pure lookup chain decide.
fn detect_term_cols() -> Option<u32> {
    if let Ok(s) = env::var("COLUMNS") {
        if let Ok(n) = s.parse::<u32>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    // TIOCGWINSZ on stderr. stdin is a pipe (the hook JSON), but stderr is
    // typically the parent terminal when launched as a Claude statusline hook.
    let mut ws = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let rc = unsafe { libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut ws) };
    if rc == 0 && ws.ws_col > 0 {
        return Some(ws.ws_col as u32);
    }
    None
}


// Socket and other daemon runtime files live under $XDG_STATE_HOME/cc-candybar
// (default ~/.local/state/cc-candybar). Caches go under $XDG_CACHE_HOME
// (default ~/.cache/cc-candybar). Both must agree with src/daemon/paths.ts —
// if these drift, the client can't find the daemon's socket.

fn socket_path() -> PathBuf {
    state_dir().join("socket")
}

fn state_dir() -> PathBuf {
    if let Some(xdg) = env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        return Path::new(&xdg).join("cc-candybar");
    }
    let home = env::var_os("HOME").unwrap_or_else(|| OsString::from("/"));
    Path::new(&home).join(".local").join("state").join("cc-candybar")
}

// --- per-session last-render cache ---------------------------------------
//
// On every successful render we drop the output bytes at
// $XDG_CACHE_HOME/cc-candybar/last-render/<sid> (default ~/.cache/cc-candybar/...).
// On a daemon-miss, we read it back and emit it instead of a blank "\n".
// A stale frame for ~1s during a daemon restart is dramatically better UX
// than the statusline blanking.
//
// Per XDG Base Directory spec, regenerable caches live under
// $XDG_CACHE_HOME, separate from the daemon's runtime state (socket,
// pidfile, log) which stays at ~/.claude/powerline/.
//
// Atomicity: write to a sibling tmp file then rename. A torn cache file
// would render as garbled ANSI for one frame; rename is cheap insurance.

fn last_render_dir() -> PathBuf {
    cache_dir().join("last-render")
}

fn cache_dir() -> PathBuf {
    if let Some(xdg) = env::var_os("XDG_CACHE_HOME").filter(|s| !s.is_empty()) {
        return Path::new(&xdg).join("cc-candybar");
    }
    let home = env::var_os("HOME").unwrap_or_else(|| OsString::from("/"));
    Path::new(&home).join(".cache").join("cc-candybar")
}

// Allow only [a-zA-Z0-9_-]. Claude session IDs are UUIDs, so this is the
// identity function in practice; the sanitizer exists so a malformed
// session_id can't traverse out of the cache directory.
fn safe_session_id(sid: &str) -> Option<String> {
    if sid.is_empty() || sid.len() > 128 {
        return None;
    }
    if sid
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Some(sid.to_owned())
    } else {
        None
    }
}

fn write_last_render(sid: &str, output: &str) -> io::Result<()> {
    let safe = match safe_session_id(sid) {
        Some(s) => s,
        None => return Ok(()), // skip — never error the user-visible path
    };
    let dir = last_render_dir();
    std::fs::create_dir_all(&dir)?;
    let final_path = dir.join(&safe);
    let tmp_path = dir.join(format!("{safe}.tmp.{}", std::process::id()));
    std::fs::write(&tmp_path, output.as_bytes())?;
    std::fs::rename(&tmp_path, &final_path)?;
    Ok(())
}

fn read_last_render(sid: &str) -> Option<String> {
    let safe = safe_session_id(sid)?;
    let path = last_render_dir().join(&safe);
    std::fs::read_to_string(&path).ok()
}

// --- framing -------------------------------------------------------------

fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    let len = body.len();
    if len > MAX_FRAME_BYTES as usize {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len}"),
        ));
    }
    let header = (len as u32).to_be_bytes();
    w.write_all(&header)?;
    w.write_all(body)?;
    w.flush()?;
    Ok(())
}

fn read_frame<R: Read>(r: &mut R) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header);
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame too large: {len}"),
        ));
    }
    let mut body = vec![0u8; len as usize];
    r.read_exact(&mut body)?;
    Ok(body)
}

// --- connect with timeout ------------------------------------------------

// std::os::unix::net::UnixStream has no connect_timeout. Roll our own:
// spawn a thread that does the blocking connect, recv with timeout. On
// timeout the thread is left to finish naturally (it'll get
// ECONNREFUSED/connect quickly and exit). For a 50ms budget this is
// cheaper than nonblocking + poll bookkeeping.
fn connect_with_timeout(path: &Path, timeout: Duration) -> io::Result<UnixStream> {
    let (tx, rx) = mpsc::channel();
    let p = path.to_path_buf();
    thread::spawn(move || {
        let result = UnixStream::connect(&p).map(|s| s.into_raw_fd());
        let _ = tx.send(result);
    });
    match rx.recv_timeout(timeout) {
        Ok(Ok(fd)) => Ok(unsafe { UnixStream::from_raw_fd(fd) }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(io::Error::new(io::ErrorKind::TimedOut, "connect timeout")),
    }
}

// --- obtain-daemon primitive --------------------------------------------
//
// [LAW:single-enforcer] One entry point on the Rust side for "obtain a
// daemon." The atomic bind() inside the daemon is the load-bearing exclusion;
// the existence-as-lock spawn.lock (open with O_CREAT | O_EXCL, release by
// unlink) is a thundering-herd optimization that prevents N concurrent
// clients from each forking a Node process when one would do.
//
// [LAW:dataflow-not-control-flow] The caller does not get to choose whether
// to spawn — it asks for a daemon, this function decides. The bind() inside
// the daemon ensures that even if this function spawns "redundantly" the
// duplicate daemon exits immediately at bind().
//
// Fire-and-forget shape: the current render is already lost (we hit
// obtain_daemon_kick on a render failure); we just want a daemon to be alive
// for the next refresh. The lock is released by explicit remove_file at the
// end of obtain_daemon_kick; if the client crashes mid-window, the time-based
// staleness reclaim in try_acquire_spawn_lock unlinks files older than 10s.
// Total work inside this fn is bounded by a few syscalls plus an optional
// fork+execve.

// Mirrors src/daemon/acquire.ts KICK_CONTENDED_OVERRIDE_MS. If the spawn.lock
// has existed longer than this, the kick path assumes the holder crashed
// mid-spawn and overrides — bind() inside the daemon arbitrates duplicates.
const KICK_CONTENDED_OVERRIDE_MS: u128 = 2_000;

// [LAW:one-type-per-behavior] Mirror of Node's LockOutcome — both runtimes
// distinguish "held / contended / error" so a Rust kick and a Node kick
// recover from the same failure modes at the same rates.
enum LockOutcome {
    Held(PathBuf),
    Contended,
    Error(String),
}

fn obtain_daemon_kick() {
    // Re-check first: a daemon may have come up between our render failure
    // and now. Cheap probe — if it's listening we have nothing to do.
    if can_connect(&socket_path(), Duration::from_millis(20)) {
        return;
    }

    match try_acquire_spawn_lock() {
        LockOutcome::Held(lock_path) => {
            // Re-check connect — a daemon may have come up between our
            // first probe and our lock acquisition.
            if !can_connect(&socket_path(), Duration::from_millis(20)) {
                spawn_daemon_detached();
            }
            // [LAW:one-type-per-behavior] Release by unlinking — Node uses
            // the same semantics so a Rust kick and a Node kick agree on
            // lock state.
            let _ = std::fs::remove_file(&lock_path);
        }
        LockOutcome::Contended => {
            // [LAW:dataflow-not-control-flow] Typical contention means
            // another caller is in the spawn window — trust them. BUT: if
            // the lock has been held suspiciously long (crashed holder), the
            // bind() inside the daemon can still arbitrate, so override.
            if let Some(age_ms) = spawn_lock_age_ms() {
                if age_ms > KICK_CONTENDED_OVERRIDE_MS {
                    eprintln!(
                        "cc-candybar: spawn-lock held {age_ms}ms (likely crashed holder) — spawning unlocked"
                    );
                    spawn_daemon_detached();
                }
            }
        }
        LockOutcome::Error(reason) => {
            // [LAW:dataflow-not-control-flow] Lock error must not be a hard
            // stop on availability — spawn.lock is an optimization, bind()
            // is load-bearing. Mirror Node's obtainDaemonKick behavior.
            eprintln!("cc-candybar: spawn-lock unavailable ({reason}) — spawning unlocked");
            spawn_daemon_detached();
        }
    }
}

fn spawn_lock_age_ms() -> Option<u128> {
    let path = state_dir().join("spawn.lock");
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    modified.elapsed().ok().map(|d| d.as_millis())
}

// [LAW:one-type-per-behavior] Existence-as-lock semantics matching the Node
// mirror in src/daemon/acquire.ts: open(path, O_CREAT | O_EXCL) atomically
// fails if the file already exists. Release by unlinking. Time-based
// staleness reclaim covers the case where a holder crashed before unlink.
//
// Staleness window matches Node's STALE_LOCK_MS (10s).
fn try_acquire_spawn_lock() -> LockOutcome {
    const STALE_LOCK: Duration = Duration::from_secs(10);
    let path = state_dir().join("spawn.lock");
    // Ensure state_dir exists; mkdir is idempotent.
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return LockOutcome::Error(format!("create_dir_all: {e}"));
        }
    }
    for _ in 0..2 {
        match File::options().create_new(true).write(true).open(&path) {
            Ok(_f) => return LockOutcome::Held(path),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return LockOutcome::Error(format!("open spawn.lock: {e}")),
        }
        // File already exists. Check staleness; if stale, unlink and retry.
        let stale = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|d| d > STALE_LOCK).unwrap_or(false))
            .unwrap_or(false);
        if !stale {
            return LockOutcome::Contended;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            // ENOENT means a racer already reclaimed; that's the desired
            // post-condition, so retry the openSync. Anything else is real.
            if e.kind() != io::ErrorKind::NotFound {
                return LockOutcome::Error(format!("unlink stale spawn.lock: {e}"));
            }
        }
    }
    LockOutcome::Contended
}

fn can_connect(sock: &Path, timeout: Duration) -> bool {
    connect_with_timeout(sock, timeout).is_ok()
}

fn spawn_daemon_detached() {
    let script = match dist_index_path() {
        Some(p) => p,
        None => return,
    };
    // [LAW:single-enforcer] All Command::new goes through launch.rs.
    let _ = launch::spawn_node_detached_daemon(&script);
}
