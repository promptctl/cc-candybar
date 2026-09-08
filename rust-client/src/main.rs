// The render hot path; subcommands exec Node. bind() is the one-daemon invariant.

mod error_glyph;
mod launch;

use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::IntoRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::FromRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

// [LAW:one-source-of-truth] Diffed against the TS wire contract by check-protocol.
pub(crate) const PROTOCOL_VERSION: u32 = 3;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(50);
const TOTAL_BUDGET: Duration = Duration::from_millis(150);
const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;
const FRAME_HEADER_BYTES: usize = 4;

fn main() {
    let argv: Vec<String> = env::args().collect();

    if should_dispatch_to_node(&argv, unsafe { libc::isatty(0) } == 1) {
        exec_node_fallback(&argv);
        eprintln!("cc-candybar: failed to exec node fallback");
        std::process::exit(1);
    }

    let parsed = match parse_stdin() {
        Ok(p) => p,
        Err(BadInput::Msg(msg)) => {
            eprintln!("cc-candybar: {msg}");
            std::process::exit(1);
        }
    };

    // [LAW:types-are-the-program] Only Transient warrants a kick; Permanent loops.
    match render(&argv, &parsed.hook_data) {
        RenderOutcome::Ok(output) => {
            let _ = io::stdout().write_all(output.as_bytes());
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
        RenderOutcome::Permanent(cause) => {
            // [LAW:single-enforcer] Glyph formatting lives in error_glyph.rs.
            let glyph = error_glyph::format_permanent_glyph(&cause);
            let _ = io::stdout().write_all(glyph.as_bytes());
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
    let hook_data: serde_json::Value =
        serde_json::from_slice(&buf).map_err(|e| BadInput::Msg(format!("stdin not JSON: {e}")))?;
    let session_id = hook_data
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    Ok(ParsedInput {
        hook_data,
        session_id,
    })
}

// [LAW:one-source-of-truth] A subcommand is a positional first arg; matching that
// SHAPE means one Node adds needs no Rust mirror. Bare flags are the exception.
const NODE_FLAGS: [&str; 4] = ["--help", "-h", "--version", "-V"];

fn should_dispatch_to_node(argv: &[String], stdin_is_tty: bool) -> bool {
    if argv.iter().any(|a| NODE_FLAGS.contains(&a.as_str())) {
        return true;
    }
    if let Some(first) = argv.get(1) {
        if !first.starts_with('-') {
            return true;
        }
    }
    // Mirror the TTY check rather than reproducing Node's needs-input message.
    stdin_is_tty
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
    // <binary_dir>/../dist/index.mjs — the same relative path in both layouts.
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("..").join("dist").join("index.mjs"))
}

// [LAW:types-are-the-program] The variant *is* the recovery decision.
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
pub enum PermanentCause {
    VersionMismatch { client_v: u32, daemon_v: u32 },
    BadRequest(String),
    RenderFailed(String),
    MalformedResponse(String),
}

// A startup-time stdin failure, NOT a render outcome: it exits before the wire.
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
    // [LAW:single-enforcer] Only the client sees the live shell context.
    let (term_cols, term_rows) = detect_term_extents();
    let ssh = detect_ssh();
    let tmux = detect_tmux();
    let config_env = detect_config_env();

    let mut request = serde_json::json!({
        "v": PROTOCOL_VERSION,
        "kind": "render",
        "hookData": hook_data,
        "args": argv,
        "cwd": cwd,
    });
    // --- client hints (mirrors ClientHints in src/daemon/protocol.ts) ---
    // [LAW:one-source-of-truth] check-protocol diffs this key set. ssh and tmux are
    // UNCONDITIONAL, which reserves absence for "client too old to report".
    if let Some(cols) = term_cols {
        request["termCols"] = serde_json::Value::from(cols);
    }
    if let Some(rows) = term_rows {
        request["termRows"] = serde_json::Value::from(rows);
    }
    request["ssh"] = serde_json::Value::from(ssh);
    request["tmux"] = tmux;
    if let Some(path) = config_env {
        request["configEnv"] = serde_json::Value::from(path);
    }
    // --- end client hints ---
    let body = match serde_json::to_vec(&request) {
        Ok(b) => b,
        // Our own request failed to encode: not a daemon problem, so Permanent.
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

// [LAW:types-are-the-program] TIMEOUT alone is Transient; a respawn cures no other.
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
            // Older daemons may not echo daemonV; 0 lets the glyph say "v?".
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

// [LAW:no-defensive-null-guards] Each errno maps to a typed cause, not a string.
// [LAW:one-type-per-behavior] A protocol violation is not a connection failure.
fn classify_io_error(e: io::Error) -> RenderOutcome {
    use io::ErrorKind::*;
    match e.kind() {
        ConnectionRefused | NotFound => {
            RenderOutcome::Transient(TransientCause::Unreachable(e.to_string()))
        }
        TimedOut | WouldBlock => RenderOutcome::Transient(TransientCause::Timeout),
        InvalidData | InvalidInput => {
            RenderOutcome::Permanent(PermanentCause::MalformedResponse(e.to_string()))
        }
        _ => RenderOutcome::Transient(TransientCause::Io(e.to_string())),
    }
}

// TimedOut, so the deadline check shares classify_io_error's path.
fn remaining_or_io(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "deadline exceeded"))
}

// TIOCGWINSZ goes to STDERR because stdin is the hook JSON pipe.
fn detect_term_extents() -> (Option<u32>, Option<u32>) {
    let mut ws = libc::winsize {
        ws_row: 0,
        ws_col: 0,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let rc = unsafe { libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut ws) };
    let (tty_cols, tty_rows) = if rc == 0 {
        (ws.ws_col as u32, ws.ws_row as u32)
    } else {
        (0, 0)
    };
    (
        detect_term_extent(env::var("COLUMNS").ok(), tty_cols),
        detect_term_extent(env::var("LINES").ok(), tty_rows),
    )
}

// [LAW:one-type-per-behavior] One fact about two axes; both suites pin one table.
fn detect_term_extent(env_value: Option<String>, tty_extent: u32) -> Option<u32> {
    if let Some(s) = env_value {
        if let Ok(n) = s.parse::<u32>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    if tty_extent > 0 {
        return Some(tty_extent);
    }
    None
}

// Diffed by check-protocol: both runtimes must agree on what "SSH" means.
const SSH_ENV_VARS: [&str; 3] = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

// [LAW:dataflow-not-control-flow] Total: "no var set" affirmatively means local.
fn detect_ssh() -> bool {
    SSH_ENV_VARS
        .iter()
        .any(|name| env::var(name).is_ok_and(|v| !v.is_empty()))
}

// Diffed by check-protocol as `role=VAR`, so a reordering is drift too.
struct TmuxEnv {
    socket: &'static str,
    pane: &'static str,
    truecolor: &'static str,
}
const TMUX_ENV: TmuxEnv = TmuxEnv {
    socket: "TMUX",
    pane: "TMUX_PANE",
    truecolor: "CLAUDE_CODE_TMUX_TRUECOLOR",
};

// The detached daemon reads no CC_CANDYBAR_CONFIG, so only the client reports it.
const CONFIG_ENV: &str = "CC_CANDYBAR_CONFIG";

// [LAW:dataflow-not-control-flow] Total: unset-or-empty means "no override".
fn detect_config_env() -> Option<String> {
    env::var(CONFIG_ENV).ok().filter(|v| !v.is_empty())
}

fn detect_tmux() -> serde_json::Value {
    let raw = |name: &str| env::var(name).ok();
    tmux_hint(raw(TMUX_ENV.socket), raw(TMUX_ENV.pane), raw(TMUX_ENV.truecolor))
}

// [LAW:dataflow-not-control-flow] Total: `Null` affirmatively means "not in tmux".
fn tmux_hint(
    tmux: Option<String>,
    pane: Option<String>,
    truecolor: Option<String>,
) -> serde_json::Value {
    let non_empty = |v: Option<String>| v.filter(|v| !v.is_empty());
    match (non_empty(tmux), non_empty(pane)) {
        (Some(tmux), Some(pane)) => serde_json::json!({
            "socket": tmux.split(',').next().unwrap_or(""),
            "pane": pane,
            "truecolor": non_empty(truecolor),
        }),
        _ => serde_json::Value::Null,
    }
}

// [LAW:one-source-of-truth] UID is kernel identity; the path ignores XDG_STATE_HOME.
fn socket_path() -> PathBuf {
    if let Some(s) = env::var_os("CC_CANDYBAR_SOCKET").filter(|s| !s.is_empty()) {
        return PathBuf::from(s);
    }
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/cc-candybar-{uid}/socket"))
}

fn state_dir() -> PathBuf {
    if let Some(xdg) = env::var_os("XDG_STATE_HOME").filter(|s| !s.is_empty()) {
        return Path::new(&xdg).join("cc-candybar");
    }
    let home = env::var_os("HOME").unwrap_or_else(|| OsString::from("/"));
    Path::new(&home)
        .join(".local")
        .join("state")
        .join("cc-candybar")
}

// A daemon-miss emits this instead of blanking; tmp-then-rename, or it tears.

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

// Exists so a malformed session_id cannot traverse out of the cache directory.
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
    let mut header = [0u8; FRAME_HEADER_BYTES];
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

// UnixStream has no connect_timeout; the thread is left to finish on timeout.
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

// [LAW:single-enforcer] One Rust entry point for "obtain a daemon".
// [LAW:dataflow-not-control-flow] The caller does not choose; bind() arbitrates.

// Past this age the kick assumes the lock holder crashed mid-spawn.
const KICK_CONTENDED_OVERRIDE_MS: u128 = 2_000;

// [LAW:one-source-of-truth] The spawn-RATE bound: spawn.lock dedups at one INSTANT,
// this over TIME, because the lock releases before the Node boot window closes.
const SPAWN_COOLDOWN_MS: u128 = 3_000;

// Both runtimes must name the SAME file or the rate bound splits in two.
const SPAWN_COOLDOWN_FILE: &str = "spawn.cooldown";

// [LAW:one-source-of-truth] Only the Node daemon resets this streak.
const SPAWN_BACKOFF_FILE: &str = "spawn.backoff";

// A max streak of 5 saturates the cap well before the shift could overflow.
const SPAWN_BACKOFF_CAP_MS: u128 = 60_000;
const SPAWN_BACKOFF_MAX_STREAK: u32 = 5;

// [LAW:one-source-of-truth] One window for two policies, over a shared file.
const STALE_LOCK_MS: u64 = 10_000;

// [LAW:one-type-per-behavior] Both runtimes recover at the same rates.
enum LockOutcome {
    Held(PathBuf),
    Contended,
    Error(String),
}

fn obtain_daemon_kick() {
    if can_connect(&socket_path(), Duration::from_millis(20)) {
        return;
    }

    match try_acquire_spawn_lock() {
        LockOutcome::Held(lock_path) => {
            if !can_connect(&socket_path(), Duration::from_millis(20)) {
                spawn_daemon_rate_limited();
            }
            // [LAW:one-type-per-behavior] Release by unlinking, as Node does.
            let _ = std::fs::remove_file(&lock_path);
        }
        LockOutcome::Contended => {
            // [LAW:dataflow-not-control-flow] Override an old lock; bind() wins.
            if let Some(age_ms) = spawn_lock_age_ms() {
                if age_ms > KICK_CONTENDED_OVERRIDE_MS {
                    eprintln!(
                        "cc-candybar: spawn-lock held {age_ms}ms (likely crashed holder) — spawning unlocked"
                    );
                    spawn_daemon_rate_limited();
                }
            }
        }
        LockOutcome::Error(reason) => {
            // [LAW:dataflow-not-control-flow] An optimization must not gate this.
            eprintln!("cc-candybar: spawn-lock unavailable ({reason}) — spawning unlocked");
            spawn_daemon_rate_limited();
        }
    }
}

// [LAW:single-enforcer] Every Rust spawn site routes through here.
fn spawn_daemon_rate_limited() {
    if !claim_spawn_cooldown() {
        return;
    }
    spawn_daemon_detached();
}

// Records BEFORE the fork, so a broken binary is not retried in a tight loop.
// [LAW:no-silent-failure] A far-future mtime would wedge the path; it warns, allows.
fn claim_spawn_cooldown() -> bool {
    let cooldown_path = spawn_cooldown_path();
    let backoff_path = spawn_backoff_path();
    let streak = read_backoff_streak(&backoff_path);
    let decision = cooldown_decision(
        cooldown_age_ms(&cooldown_path),
        effective_cooldown_ms(streak),
    );
    // [LAW:types-are-the-program] Exhaustive: a fourth variant must not compile.
    match decision {
        CooldownDecision::Deny => return false,
        CooldownDecision::AllowFutureGarbage(future_ms) => {
            eprintln!(
                "cc-candybar: spawn.cooldown mtime is {future_ms}ms in the future — ignoring and spawning"
            );
        }
        CooldownDecision::Allow => {}
    }
    record_spawn_attempt(&cooldown_path);
    // [LAW:dataflow-not-control-flow] The cap is a min(), never a skip.
    write_backoff_streak(&backoff_path, (streak + 1).min(SPAWN_BACKOFF_MAX_STREAK));
    true
}

// [LAW:effects-at-boundaries] Pure over the age; the delta rides AllowFutureGarbage.
#[derive(Debug)]
enum CooldownDecision {
    Allow,
    AllowFutureGarbage(i128),
    Deny,
}

// [LAW:types-are-the-program] A parameter, so one fold serves both windows.
fn cooldown_decision(age_ms: Option<i128>, cooldown_ms: u128) -> CooldownDecision {
    match age_ms {
        Some(age) if age < -(STALE_LOCK_MS as i128) => CooldownDecision::AllowFutureGarbage(-age),
        Some(age) if age < cooldown_ms as i128 => CooldownDecision::Deny,
        _ => CooldownDecision::Allow,
    }
}

// [LAW:behavior-not-structure] Pure over the streak; no filesystem.
fn effective_cooldown_ms(streak: u32) -> u128 {
    let capped = streak.min(SPAWN_BACKOFF_MAX_STREAK);
    (SPAWN_COOLDOWN_MS << capped).min(SPAWN_BACKOFF_CAP_MS)
}

fn spawn_backoff_path() -> PathBuf {
    state_dir().join(SPAWN_BACKOFF_FILE)
}

// [LAW:no-silent-failure] A bad streak file fails toward 0, never wedged.
// [LAW:no-defensive-null-guards] Clamped, so `streak + 1` can never overflow.
fn read_backoff_streak(path: &Path) -> u32 {
    let streak = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    streak.min(SPAWN_BACKOFF_MAX_STREAK)
}

// [LAW:no-ambient-temporal-coupling] Not atomic, but a race can only undercount.
fn write_backoff_streak(path: &Path, streak: u32) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // 0o600 in both runtimes, so permissions do not depend on which created it.
    let result = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .and_then(|mut f| f.write_all(streak.to_string().as_bytes()));
    if let Err(e) = result {
        eprintln!("cc-candybar: could not record spawn.backoff: {e}");
    }
}

fn spawn_cooldown_path() -> PathBuf {
    state_dir().join(SPAWN_COOLDOWN_FILE)
}

// now - mtime, in ms; negative for a future mtime.
fn cooldown_age_ms(path: &Path) -> Option<i128> {
    let modified = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    match modified.elapsed() {
        Ok(d) => Some(d.as_millis() as i128),
        Err(e) => Some(-(e.duration().as_millis() as i128)),
    }
}

fn record_spawn_attempt(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    // The mtime is the authority; a write failure is loud, not silent.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Err(e) = std::fs::write(path, format!("{} {}\n", std::process::id(), now)) {
        eprintln!("cc-candybar: could not record spawn.cooldown: {e}");
    }
}

fn spawn_lock_age_ms() -> Option<u128> {
    let path = state_dir().join("spawn.lock");
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    modified.elapsed().ok().map(|d| d.as_millis())
}

// [LAW:one-type-per-behavior] Existence-as-lock with a staleness reclaim, as Node.
fn try_acquire_spawn_lock() -> LockOutcome {
    const STALE_LOCK: Duration = Duration::from_millis(STALE_LOCK_MS);
    let path = state_dir().join("spawn.lock");
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
        let stale = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().map(|d| d > STALE_LOCK).unwrap_or(false))
            .unwrap_or(false);
        if !stale {
            return LockOutcome::Contended;
        }
        if let Err(e) = std::fs::remove_file(&path) {
            // ENOENT is the desired post-condition; anything else is real.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    // The same table as test/term-extent.test.ts.
    #[test]
    fn detect_term_extent_parses_exactly_what_the_ts_client_parses() {
        let env = |s: &str| detect_term_extent(Some(s.to_string()), 0);
        assert_eq!(env("80"), Some(80));
        assert_eq!(env("+80"), Some(80));
        assert_eq!(env("080"), Some(80));
        assert_eq!(env("4294967295"), Some(4294967295));
        for rejected in ["", "0", " 80", "80 ", "80.5", "80\n", "80abc", "-80", "4294967296"] {
            assert_eq!(env(rejected), None, "{rejected:?}");
        }
        assert_eq!(detect_term_extent(Some("x".to_string()), 24), Some(24));
        assert_eq!(detect_term_extent(None, 24), Some(24));
        assert_eq!(detect_term_extent(None, 0), None);
    }

    // The same table as test/doctor-checks.test.ts (detectTmuxHint).
    #[test]
    fn tmux_hint_reads_exactly_what_the_ts_client_reads() {
        let s = |v: &str| Some(v.to_string());
        let socket = "/tmp/tmux-501/default,123,0";
        assert_eq!(tmux_hint(None, None, None), serde_json::Value::Null);
        assert_eq!(tmux_hint(s(socket), None, None), serde_json::Value::Null);
        assert_eq!(tmux_hint(None, s("%1"), None), serde_json::Value::Null);
        assert_eq!(tmux_hint(s(""), s("%1"), None), serde_json::Value::Null);
        assert_eq!(
            tmux_hint(s(socket), s("%1"), None),
            serde_json::json!({ "socket": "/tmp/tmux-501/default", "pane": "%1", "truecolor": null })
        );
        assert_eq!(
            tmux_hint(s(socket), s("%1"), s("1")),
            serde_json::json!({ "socket": "/tmp/tmux-501/default", "pane": "%1", "truecolor": "1" })
        );
        assert_eq!(
            tmux_hint(s(socket), s("%1"), s("")),
            serde_json::json!({ "socket": "/tmp/tmux-501/default", "pane": "%1", "truecolor": null })
        );
    }

    // [LAW:one-type-per-behavior] A kick will not fix garbage on the wire.
    #[test]
    fn classify_io_error_routes_invalid_data_to_permanent() {
        for kind in [io::ErrorKind::InvalidData, io::ErrorKind::InvalidInput] {
            let outcome = classify_io_error(io::Error::new(kind, "frame too large: 99999999"));
            match outcome {
                RenderOutcome::Permanent(PermanentCause::MalformedResponse(msg)) => {
                    assert!(
                        msg.contains("frame too large"),
                        "expected message to carry the protocol context, got: {msg:?}"
                    );
                }
                other => panic!("expected Permanent(MalformedResponse), got: {other:?}"),
            }
        }
    }

    #[test]
    fn classify_io_error_keeps_connection_errors_transient() {
        let conn = classify_io_error(io::Error::from(io::ErrorKind::ConnectionRefused));
        assert!(matches!(
            conn,
            RenderOutcome::Transient(TransientCause::Unreachable(_))
        ));
        let nf = classify_io_error(io::Error::from(io::ErrorKind::NotFound));
        assert!(matches!(
            nf,
            RenderOutcome::Transient(TransientCause::Unreachable(_))
        ));
        let to = classify_io_error(io::Error::from(io::ErrorKind::TimedOut));
        assert!(matches!(
            to,
            RenderOutcome::Transient(TransientCause::Timeout)
        ));
    }

    #[test]
    fn classify_io_error_default_is_transient_io() {
        let other = classify_io_error(io::Error::new(io::ErrorKind::Other, "something"));
        assert!(matches!(
            other,
            RenderOutcome::Transient(TransientCause::Io(_))
        ));
    }

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    // [LAW:one-source-of-truth] A name list fails silently on an unknown subcommand.
    #[test]
    fn dispatch_routes_every_subcommand_to_node() {
        for cmd in [
            "install",
            "install-url-handler",
            "url-handle",
            "daemon",
            "daemon-stats",
            "lint",
            "schema",
            "vars",
            "segments",
            "config",
        ] {
            assert!(
                should_dispatch_to_node(&argv(&["cc-candybar", cmd]), false),
                "subcommand `{cmd}` must dispatch to Node even with non-TTY stdin"
            );
        }
    }

    #[test]
    fn dispatch_keeps_render_invocation_local() {
        assert!(!should_dispatch_to_node(
            &argv(&["cc-candybar", "--style=powerline"]),
            false
        ));
        assert!(!should_dispatch_to_node(&argv(&["cc-candybar"]), false));
    }

    // [LAW:behavior-not-structure] Pins the just-recorded/garbage boundary.
    #[test]
    fn cooldown_absent_record_allows() {
        assert!(matches!(
            cooldown_decision(None, SPAWN_COOLDOWN_MS),
            CooldownDecision::Allow
        ));
    }

    #[test]
    fn cooldown_within_window_denies() {
        assert!(matches!(
            cooldown_decision(Some(0), SPAWN_COOLDOWN_MS),
            CooldownDecision::Deny
        ));
        assert!(matches!(
            cooldown_decision(Some(SPAWN_COOLDOWN_MS as i128 - 1), SPAWN_COOLDOWN_MS),
            CooldownDecision::Deny
        ));
    }

    #[test]
    fn cooldown_at_and_past_window_allows() {
        // The window is half-open: exactly SPAWN_COOLDOWN_MS old has expired.
        assert!(matches!(
            cooldown_decision(Some(SPAWN_COOLDOWN_MS as i128), SPAWN_COOLDOWN_MS),
            CooldownDecision::Allow
        ));
        assert!(matches!(
            cooldown_decision(Some(SPAWN_COOLDOWN_MS as i128 + 5_000), SPAWN_COOLDOWN_MS),
            CooldownDecision::Allow
        ));
    }

    #[test]
    fn cooldown_small_future_is_precision_skew_denies() {
        // A slightly-future mtime is precision skew, not garbage.
        assert!(matches!(
            cooldown_decision(Some(-1), SPAWN_COOLDOWN_MS),
            CooldownDecision::Deny
        ));
        assert!(matches!(
            cooldown_decision(Some(-(STALE_LOCK_MS as i128)), SPAWN_COOLDOWN_MS),
            CooldownDecision::Deny
        ));
    }

    #[test]
    fn cooldown_far_future_is_garbage_allows_loudly() {
        match cooldown_decision(Some(-(STALE_LOCK_MS as i128) - 1), SPAWN_COOLDOWN_MS) {
            CooldownDecision::AllowFutureGarbage(ms) => {
                assert_eq!(ms, STALE_LOCK_MS as i128 + 1)
            }
            other => panic!("expected AllowFutureGarbage, got {other:?}"),
        }
        assert!(matches!(
            cooldown_decision(Some(-3_600_000), SPAWN_COOLDOWN_MS),
            CooldownDecision::AllowFutureGarbage(_)
        ));
    }

    // Anchored to STALE_LOCK_MS, so a backed-off window cannot swallow clock skew.
    #[test]
    fn cooldown_future_garbage_boundary_independent_of_cooldown_window() {
        match cooldown_decision(Some(-(STALE_LOCK_MS as i128) - 1), SPAWN_BACKOFF_CAP_MS) {
            CooldownDecision::AllowFutureGarbage(ms) => {
                assert_eq!(ms, STALE_LOCK_MS as i128 + 1)
            }
            other => panic!("expected AllowFutureGarbage, got {other:?}"),
        }
    }

    // [LAW:behavior-not-structure] Pins the streak-to-window mapping and its cap.
    #[test]
    fn effective_cooldown_streak_zero_is_base_rate() {
        assert_eq!(effective_cooldown_ms(0), SPAWN_COOLDOWN_MS);
    }

    #[test]
    fn effective_cooldown_doubles_per_streak() {
        assert_eq!(effective_cooldown_ms(1), SPAWN_COOLDOWN_MS * 2);
        assert_eq!(effective_cooldown_ms(2), SPAWN_COOLDOWN_MS * 4);
        assert_eq!(effective_cooldown_ms(3), SPAWN_COOLDOWN_MS * 8);
    }

    #[test]
    fn effective_cooldown_caps_at_backoff_cap() {
        assert_eq!(
            effective_cooldown_ms(SPAWN_BACKOFF_MAX_STREAK),
            SPAWN_BACKOFF_CAP_MS
        );
        // Streaks beyond the max must not overflow the shift or exceed the cap.
        assert_eq!(
            effective_cooldown_ms(SPAWN_BACKOFF_MAX_STREAK + 1),
            SPAWN_BACKOFF_CAP_MS
        );
        assert_eq!(effective_cooldown_ms(1_000_000), SPAWN_BACKOFF_CAP_MS);
    }

    // [LAW:one-source-of-truth] Spelled out, not read from NODE_FLAGS: a pin.
    #[test]
    fn dispatch_routes_every_node_flag_to_node() {
        for flag in ["--help", "-h", "--version", "-V"] {
            for tty in [false, true] {
                assert!(
                    should_dispatch_to_node(&argv(&["cc-candybar", flag]), tty),
                    "flag `{flag}` must dispatch to Node with stdin_is_tty={tty}"
                );
            }
        }
    }

    #[test]
    fn dispatch_tty_without_subcommand_to_node() {
        assert!(should_dispatch_to_node(&argv(&["cc-candybar"]), true));
    }
}
