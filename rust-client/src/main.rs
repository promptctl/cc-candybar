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
//   - PROTOCOL_VERSION = 2
//
// Timeouts mirror src/daemon/client.ts: 50ms connect, 150ms total.
//
// On any daemon failure: spawn detached `node <root>/dist/index.mjs daemon`,
// write "\n" to stdout, exit 0. Matches src/index.ts:166 daemon-miss
// behavior so the next refresh hits a warm daemon.

use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::io::FromRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u32 = 2;
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
        Err(RenderError::BadInput(msg)) => {
            eprintln!("cc-candybar: {msg}");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("cc-candybar: {e:?}");
            std::process::exit(1);
        }
    };

    match render(&argv, &parsed.hook_data) {
        Ok(output) => {
            let _ = io::stdout().write_all(output.as_bytes());
            // Persist for the next daemon-miss. Best-effort: if disk is
            // full or perms are wrong, the user just gets a blink later
            // instead of a stale frame — same as today's behavior.
            if let Some(sid) = parsed.session_id.as_deref() {
                let _ = write_last_render(sid, &output);
            }
            std::process::exit(0);
        }
        Err(_reason) => {
            // Daemon unreachable / errored / timed out. Spawn a detached
            // daemon for the next refresh, then output the most recent
            // successful render for THIS session (if we have one) instead
            // of a blank "\n". A stale frame for ~1s during daemon
            // restart is much better UX than the statusline blanking.
            spawn_detached_daemon();
            let stale = parsed
                .session_id
                .as_deref()
                .and_then(|sid| read_last_render(sid));
            let bytes = stale.as_deref().map(str::as_bytes).unwrap_or(b"\n");
            let _ = io::stdout().write_all(bytes);
            std::process::exit(0);
        }
    }
}

struct ParsedInput {
    hook_data: serde_json::Value,
    session_id: Option<String>,
}

fn parse_stdin() -> Result<ParsedInput, RenderError> {
    let mut buf = Vec::with_capacity(4096);
    io::stdin().read_to_end(&mut buf)?;
    if buf.is_empty() {
        return Err(RenderError::BadInput(
            "no input on stdin (this tool reads hook data from Claude Code)".into(),
        ));
    }
    let hook_data: serde_json::Value = serde_json::from_slice(&buf)
        .map_err(|e| RenderError::BadInput(format!("stdin not JSON: {e}")))?;
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
    let mut cmd = Command::new("node");
    cmd.arg(script.as_os_str());
    for a in argv.iter().skip(1) {
        cmd.arg(a);
    }
    // execvp — replaces this process. Returns only on error.
    let err = cmd.exec();
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

#[derive(Debug)]
#[allow(dead_code)] // payload fields read only via Debug for diagnostics
enum RenderError {
    BadInput(String),
    Io(io::Error),
    Timeout,
    Protocol(String),
}

impl From<io::Error> for RenderError {
    fn from(e: io::Error) -> Self {
        RenderError::Io(e)
    }
}

fn render(argv: &[String], hook_data: &serde_json::Value) -> Result<String, RenderError> {
    let deadline = Instant::now() + TOTAL_BUDGET;
    let cwd = env::current_dir()?.to_string_lossy().into_owned();

    let request = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "kind": "render",
        "hookData": hook_data,
        "args": argv,
        "cwd": cwd,
    });
    let body = serde_json::to_vec(&request)
        .map_err(|e| RenderError::Protocol(format!("encode: {e}")))?;

    let socket = socket_path();
    let mut sock = connect_with_timeout(&socket, CONNECT_TIMEOUT)
        .map_err(|e| RenderError::Io(e))?;

    sock.set_write_timeout(Some(remaining(deadline)?))?;
    write_frame(&mut sock, &body)?;

    sock.set_read_timeout(Some(remaining(deadline)?))?;
    let resp_body = read_frame(&mut sock)?;

    let resp: serde_json::Value = serde_json::from_slice(&resp_body)
        .map_err(|e| RenderError::Protocol(format!("decode: {e}")))?;

    let ok = resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if !ok {
        let code = resp
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");
        return Err(RenderError::Protocol(format!("daemon error: {code}")));
    }
    let output = resp
        .get("output")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RenderError::Protocol("response missing output".into()))?;
    Ok(output.to_string())
}

fn remaining(deadline: Instant) -> Result<Duration, RenderError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or(RenderError::Timeout)
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

fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> Result<(), RenderError> {
    let len = body.len();
    if len > MAX_FRAME_BYTES as usize {
        return Err(RenderError::Protocol(format!("frame too large: {len}")));
    }
    let header = (len as u32).to_be_bytes();
    w.write_all(&header)?;
    w.write_all(body)?;
    w.flush()?;
    Ok(())
}

fn read_frame<R: Read>(r: &mut R) -> Result<Vec<u8>, RenderError> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header)?;
    let len = u32::from_be_bytes(header);
    if len > MAX_FRAME_BYTES {
        return Err(RenderError::Protocol(format!("frame too large: {len}")));
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

// --- detached daemon spawn ----------------------------------------------

fn spawn_detached_daemon() {
    let script = match dist_index_path() {
        Some(p) => p,
        None => return,
    };
    let dev_null = match File::options().read(true).write(true).open("/dev/null") {
        Ok(f) => f,
        Err(_) => return,
    };
    // Three independent fds (stdin/stdout/stderr) so closing one in the
    // child doesn't take the others down.
    let stdin_fd = match dev_null.try_clone() {
        Ok(f) => Stdio::from(f),
        Err(_) => return,
    };
    let stdout_fd = match dev_null.try_clone() {
        Ok(f) => Stdio::from(f),
        Err(_) => return,
    };
    let stderr_fd = Stdio::from(dev_null);

    let mut cmd = Command::new("node");
    cmd.arg(script.as_os_str())
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
    let _ = cmd.spawn(); // do not wait; child runs detached
}
