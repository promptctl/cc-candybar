// `cc-candybar follow --lane <lane> --session <id>`: a named session's frames,
// relayed for whatever draws them faster than Claude Code reruns a statusline
// — the band mod's per-session child (mod/hooks/register.tsx), a whole Node
// process before this. Each message the daemon sends the lane's subscriber is
// one line on stdout, as it was sent: the daemon encodes each lane's frames
// (src/daemon/lane-frames.ts), so this relays bytes and decides only what a
// stream's end calls for.
//
// It mirrors the Node follower (src/daemon/frame-follow.ts,
// src/daemon/client-frames.ts, and what src/frames-cli.ts says). Its four
// decisions — frame or refusal, what a stream's end calls for, what is worth
// saying, the backoff — are the cases in test/fixtures/frame-follow-cases.json,
// which both runtimes' tests assert; its constants are rows of
// scripts/check-protocol.mjs.

use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::thread;
use std::time::Duration;

use serde::Deserialize;

use crate::{obtain_daemon_kick, read_frame, socket_path, write_frame, PROTOCOL_VERSION};

// [LAW:one-source-of-truth] Mirrors LANES in src/config/lanes.ts.
const LANE_NAMES: [&str; 4] = ["band", "statusline", "pane", "tmuxStatus"];
// [LAW:one-source-of-truth] Mirror src/daemon/frame-follow.ts.
const RECONNECT_FIRST_MS: u64 = 250;
const RECONNECT_MAX_MS: u64 = 2000;
const SWITCHED_OFF_RETRY_MS: u64 = 5000;

const USAGE_HEAD: &str = "usage: cc-candybar follow --lane";

fn usage() -> String {
    format!(
        "{USAGE_HEAD} <{}> --session <id>

A named session's frames, as the daemon pushes them: each message the daemon
sends the lane's subscriber, one JSON line on stdout, until stdout closes or the
process that started it exits. The frames are drawn from the data the session's
own statusline client sends.

The stream outlives the daemon: one that ends is reconnected, starting a daemon
when none answers. While the lane's toggle is off the daemon's refusal is
written once, and asked again every {}s. What goes wrong is said on stderr.

Exit 2: bad arguments. Exit 1: a daemon that refuses for good (it speaks a newer
protocol than this client). Exit 0: stdout closed, or the process that started
it exited.
",
        LANE_NAMES.join("|"),
        SWITCHED_OFF_RETRY_MS / 1000
    )
}

struct Args {
    lane: String,
    session: String,
}

// [LAW:parse-dont-validate] The one crossing from argv to a subscription this
// client sends well formed — so a daemon answering BAD_REQUEST is one from
// before subscribe, never this client's mistake.
fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut lane: Option<String> = None;
    let mut session: Option<String> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (arg.as_str(), None),
        };
        let slot = match name {
            "--lane" => &mut lane,
            "--session" => &mut session,
            _ => return Err(format!("unknown option {}", serde_json::json!(arg))),
        };
        *slot = inline.or_else(|| rest.next().cloned());
    }
    let lane = lane
        .filter(|l| LANE_NAMES.contains(&l.as_str()))
        .ok_or_else(|| format!("--lane needs one of {}", LANE_NAMES.join(", ")))?;
    let session = session
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "--session needs a session id".to_string())?;
    Ok(Args { lane, session })
}

// --- the four decisions ---------------------------------------------------

// [LAW:parse-dont-validate] The fields of a message the follower decides by,
// read off it whole; the rest it relays unread. A refusal is this head, its
// sentence, and the protocol the daemon speaks (absent from a daemon too old
// to echo it). A message that says no `ok` is not ok, as isRefusal reads it.
#[derive(Debug, Deserialize)]
struct Head {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    code: String,
    #[serde(default)]
    error: String,
    #[serde(rename = "daemonV")]
    daemon_v: Option<u64>,
}

// [LAW:types-are-the-program] One message on a stream: a frame (`ok`: the bar
// drawn, or not — RENDER_FAILED), or a refusal, which ends the stream.
#[derive(Debug)]
enum Message {
    Frame { ok: bool },
    Refusal(Head),
}

// Mirrors isRefusal in src/daemon/client-frames.ts.
fn classify(head: Head) -> Message {
    match (head.ok, head.code.as_str()) {
        (true, _) => Message::Frame { ok: true },
        (false, "RENDER_FAILED") => Message::Frame { ok: false },
        (false, _) => Message::Refusal(head),
    }
}

// Why a stream ended. Mirrors StreamEnd in src/daemon/client-frames.ts, less
// the end this process never asks for (closing it here: stdout closing exits).
// A refusal keeps its bytes, which the lane switched off writes as its line.
#[derive(Debug)]
enum StreamEnd {
    Failed(String),
    ClosedThere,
    Refused(Head, Vec<u8>),
}

#[derive(Debug, PartialEq)]
enum AfterEnd {
    Reconnect { reason: String, kick: bool },
    Off,
    Exit(String),
}

// Mirrors afterStreamEnd in src/daemon/frame-follow.ts.
fn after_stream_end(end: &StreamEnd) -> AfterEnd {
    let reconnect = |reason: String, kick: bool| AfterEnd::Reconnect { reason, kick };
    match end {
        StreamEnd::Failed(why) => reconnect(format!("stream failed ({why})"), true),
        StreamEnd::ClosedThere => reconnect("daemon closed the stream".into(), false),
        StreamEnd::Refused(r, _) => match r.code.as_str() {
            "SWITCHED_OFF" => AfterEnd::Off,
            "TIMEOUT" => reconnect(
                format!("the daemon was too busy to open the stream ({})", r.error),
                false,
            ),
            "BAD_REQUEST" => reconnect(
                format!(
                    "the daemon does not take subscribe ({}); it restarts on the new build",
                    r.error
                ),
                false,
            ),
            "VERSION_MISMATCH" if r.daemon_v.is_some_and(|v| v < u64::from(PROTOCOL_VERSION)) => {
                reconnect(format!("the daemon is older than this client ({})", r.error), true)
            }
            _ => AfterEnd::Exit(format!("the daemon refused the stream: {}: {}", r.code, r.error)),
        },
    }
}

// What the stream last said. Mirrors Said in src/frames-cli.ts.
#[derive(Debug, Clone, PartialEq)]
enum Said {
    None,
    Frame,
    Off,
    Fault(String),
}

// [LAW:types-are-the-program] Mirrors worthSaying in src/frames-cli.ts: every
// frame, and any other event that differs from the last thing said. So a state
// that persists across retries is said once, and every change is said — a
// refusal after a fault is written again, so the band, which clears what
// stderr said at the next stdout line, always gets that line.
fn worth_saying(last: &Said, next: &Said) -> bool {
    match (last, next) {
        (_, Said::Frame) => true,
        (Said::Fault(a), Said::Fault(b)) => a != b,
        _ => std::mem::discriminant(last) != std::mem::discriminant(next),
    }
}

#[derive(Debug, Clone, Copy)]
enum RetryEvent {
    FrameOk,
    FrameFailed,
    Fault,
}

// Mirrors nextRetryMs in src/daemon/frame-follow.ts.
fn next_retry_ms(retry_ms: u64, event: RetryEvent) -> u64 {
    match event {
        RetryEvent::FrameOk => RECONNECT_FIRST_MS,
        RetryEvent::FrameFailed => retry_ms,
        RetryEvent::Fault => (retry_ms * 2).min(RECONNECT_MAX_MS),
    }
}

// --- the follower ---------------------------------------------------------

// [LAW:no-silent-failure] A reader that went away is the end of the stream,
// not an error to keep writing into: stdout or stderr closing exits 0.
fn say(line: &str) {
    if writeln!(io::stderr(), "cc-candybar follow: {line}").is_err() {
        std::process::exit(0);
    }
}

fn emit(body: &[u8]) {
    let mut out = io::stdout().lock();
    if out.write_all(body).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).is_err() {
        std::process::exit(0);
    }
}

struct Follower {
    args: Args,
    retry_ms: u64,
    said: Said,
}

impl Follower {
    fn tell(&mut self, next: Said, write: impl FnOnce()) {
        if worth_saying(&self.said, &next) {
            write();
        }
        self.said = next;
    }

    // One stream, one connection: its frames to stdout until it ends.
    fn stream(&mut self) -> StreamEnd {
        let mut sock = match UnixStream::connect(socket_path()) {
            Ok(s) => s,
            Err(e) => return StreamEnd::Failed(e.to_string()),
        };
        let subscribe = serde_json::json!({
            "v": PROTOCOL_VERSION,
            "kind": "subscribe",
            "sessionId": self.args.session,
            "lane": self.args.lane,
        });
        let request = serde_json::to_vec(&subscribe).expect("a subscribe of strings serializes");
        if let Err(e) = write_frame(&mut sock, &request) {
            return StreamEnd::Failed(e.to_string());
        }
        loop {
            let body = match read_frame(&mut sock) {
                Ok(b) => b,
                Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return StreamEnd::ClosedThere,
                Err(e) => return StreamEnd::Failed(e.to_string()),
            };
            let head: Head = match serde_json::from_slice(&body) {
                Ok(h) => h,
                Err(e) => return StreamEnd::Failed(format!("a frame would not parse: {e}")),
            };
            match classify(head) {
                Message::Refusal(r) => return StreamEnd::Refused(r, body),
                Message::Frame { ok } => {
                    let event = if ok { RetryEvent::FrameOk } else { RetryEvent::FrameFailed };
                    self.retry_ms = next_retry_ms(self.retry_ms, event);
                    // The bytes read are the line, as the daemon sent them.
                    self.tell(Said::Frame, || emit(&body));
                }
            }
        }
    }

    // [LAW:no-ambient-temporal-coupling] One stream or one wait at a time: a
    // stream's end decides the wait before the next.
    fn run(mut self) -> ! {
        loop {
            let end = self.stream();
            match after_stream_end(&end) {
                AfterEnd::Exit(reason) => {
                    say(&reason);
                    std::process::exit(1);
                }
                AfterEnd::Off => {
                    let StreamEnd::Refused(_, body) = end else {
                        unreachable!("only a refusal switches the lane off")
                    };
                    self.tell(Said::Off, || emit(&body));
                    thread::sleep(Duration::from_millis(SWITCHED_OFF_RETRY_MS));
                }
                AfterEnd::Reconnect { reason, kick } => {
                    let wait = self.retry_ms;
                    self.tell(Said::Fault(reason.clone()), || {
                        say(&format!("{reason}; reconnecting in {wait}ms"))
                    });
                    if kick {
                        obtain_daemon_kick();
                    }
                    self.retry_ms = next_retry_ms(wait, RetryEvent::Fault);
                    thread::sleep(Duration::from_millis(wait));
                }
            }
        }
    }
}

// [LAW:no-silent-failure] The reader of stdout is the process that started
// this one. A still bar, or a lane switched off, writes nothing for as long as
// it lasts, so a reader that died would go unnoticed by the next write; the
// parent's exit, which reparents this process, is asked after instead. The
// parent is read as this process starts: pid 1 is a parent too, when Claude
// Code is a container's init.
fn exit_with_parent() {
    let parent = unsafe { libc::getppid() };
    thread::spawn(move || {
        while unsafe { libc::getppid() } == parent {
            thread::sleep(Duration::from_secs(1));
        }
        std::process::exit(0);
    });
}

pub fn run(args: &[String]) -> ! {
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", usage());
        std::process::exit(0);
    }
    match parse_args(args) {
        Ok(args) => {
            exit_with_parent();
            Follower { args, retry_ms: RECONNECT_FIRST_MS, said: Said::None }.run()
        }
        Err(why) => {
            // Exit 2 is the answer; the line goes where it can.
            let _ = writeln!(io::stderr(), "cc-candybar follow: {why}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // [LAW:one-source-of-truth] The same cases test/frame-follow-cases.test.ts
    // asserts against the Node follower.
    const CASES: &str = include_str!("../../test/fixtures/frame-follow-cases.json");

    fn cases(section: &str) -> Vec<Value> {
        let all: Value = serde_json::from_str(CASES).expect("the fixture is JSON");
        all[section].as_array().expect("a section is a list").clone()
    }

    fn version_of(v: &Value) -> Option<u64> {
        let ours = u64::from(PROTOCOL_VERSION);
        match v.as_str() {
            Some("older") => Some(ours - 1),
            Some("newer") => Some(ours + 1),
            _ => None,
        }
    }

    fn head_of(raw: &Value) -> Head {
        let mut resp = raw.clone();
        if let Some(v) = version_of(&raw["daemonV"]) {
            resp["daemonV"] = Value::from(v);
        }
        serde_json::from_value(resp).expect("a case is a message")
    }

    fn said_of(raw: &Value) -> Said {
        match raw["kind"].as_str() {
            Some("none") => Said::None,
            Some("frame") => Said::Frame,
            Some("off") => Said::Off,
            Some("fault") => Said::Fault(raw["reason"].as_str().unwrap().to_string()),
            other => panic!("no Said {other:?}"),
        }
    }

    #[test]
    fn message_cases() {
        for case in cases("message") {
            let refusal = matches!(classify(head_of(&case["resp"])), Message::Refusal(_));
            assert_eq!(refusal, case["refusal"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn stream_end_cases() {
        for case in cases("streamEnd") {
            let end = match case["end"]["kind"].as_str().unwrap() {
                "failed" => StreamEnd::Failed("ECONNREFUSED".into()),
                "closed-there" => StreamEnd::ClosedThere,
                "refused" => StreamEnd::Refused(
                    Head {
                        ok: false,
                        code: case["end"]["code"].as_str().unwrap().to_string(),
                        error: "said".into(),
                        daemon_v: version_of(&case["end"]["daemonV"]),
                    },
                    Vec::new(),
                ),
                other => panic!("no StreamEnd {other}"),
            };
            let then = &case["then"];
            match (after_stream_end(&end), then["kind"].as_str().unwrap()) {
                (AfterEnd::Reconnect { kick, .. }, "reconnect") => {
                    assert_eq!(kick, then["kick"].as_bool().unwrap(), "{case}")
                }
                (AfterEnd::Off, "off") | (AfterEnd::Exit(_), "exit") => {}
                (got, _) => panic!("{case}: got {got:?}"),
            }
        }
    }

    #[test]
    fn worth_saying_cases() {
        for case in cases("worthSaying") {
            let says = worth_saying(&said_of(&case["last"]), &said_of(&case["next"]));
            assert_eq!(says, case["says"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn backoff_cases() {
        for case in cases("backoff") {
            let event = match case["event"].as_str().unwrap() {
                "frame-ok" => RetryEvent::FrameOk,
                "frame-failed" => RetryEvent::FrameFailed,
                "fault" => RetryEvent::Fault,
                other => panic!("no RetryEvent {other}"),
            };
            let next = next_retry_ms(case["retryMs"].as_u64().unwrap(), event);
            assert_eq!(next, case["next"].as_u64().unwrap(), "{case}");
        }
    }

    fn argv(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_well_formed_subscription_parses_in_either_spelling() {
        for args in [
            argv(&["--lane", "band", "--session", "s-1"]),
            argv(&["--lane=band", "--session=s-1"]),
        ] {
            let parsed = parse_args(&args).unwrap();
            assert_eq!((parsed.lane.as_str(), parsed.session.as_str()), ("band", "s-1"));
        }
    }

    #[test]
    fn a_subscription_this_client_could_not_send_well_formed_is_refused() {
        let lanes = "--lane needs one of band, statusline, pane, tmuxStatus";
        for (args, why) in [
            (argv(&["--session", "s"]), lanes),
            (argv(&["--lane", "everywhere", "--session", "s"]), lanes),
            (argv(&["--lane", "band"]), "--session needs a session id"),
            (argv(&["--lane", "band", "--session", ""]), "--session needs a session id"),
            (argv(&["--lane", "band", "--session", "s", "--format", "band"]), "unknown option \"--format\""),
        ] {
            assert_eq!(parse_args(&args).err().as_deref(), Some(why), "{args:?}");
        }
    }

    #[test]
    fn usage_names_every_lane() {
        assert!(usage().starts_with(&format!("{USAGE_HEAD} <band|statusline|pane|tmuxStatus> --session <id>")));
    }
}
