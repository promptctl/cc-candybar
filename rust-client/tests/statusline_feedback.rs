use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const WAIT: &str = "\x1b[1mCandybar · waiting for daemon…\x1b[0m\n";
const DEFAULT_TIMEOUT: &str =
    "\x1b[1mCandybar timed out\x1b[0m · tail -n 40 ~/.local/state/cc-candybar/daemon.log\n";
const XDG_TIMEOUT: &str =
    "\x1b[1mCandybar timed out\x1b[0m · tail -n 40 \"$XDG_STATE_HOME/cc-candybar/daemon.log\"\n";

struct Client {
    home: PathBuf,
}

impl Client {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        // Keep the private socket within the Unix pathname length limit.
        let home = PathBuf::from(format!("/tmp/ccb-feedback-{}-{nonce}", std::process::id()));
        fs::create_dir(&home).unwrap();
        Self { home }
    }

    fn cache(&self) -> PathBuf {
        self.home.join(".cache/cc-candybar/last-render/feedback")
    }

    fn state(&self) -> PathBuf {
        self.home.join(".local/state/cc-candybar")
    }

    fn tick(&self, reply: Option<Value>, xdg_state_home: Option<&str>) -> String {
        let socket = self.home.join("host.sock");
        if let Some(reply) = reply {
            let listener = UnixListener::bind(&socket).unwrap();
            let socket = socket.clone();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                // Any subsequent recovery probe must find the socket absent.
                drop(listener);
                fs::remove_file(socket).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut header = [0; 4];
                stream.read_exact(&mut header).unwrap();
                let length = u32::from_be_bytes(header) as usize;
                assert!((1..=65536).contains(&length));
                let mut request = vec![0; length];
                stream.read_exact(&mut request).unwrap();
                let payload = serde_json::to_vec(&reply).unwrap();
                stream
                    .write_all(&(payload.len() as u32).to_be_bytes())
                    .unwrap();
                stream.write_all(&payload).unwrap();
            });
        }
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_cc-candybar"));
        cmd.env_clear()
            .env("HOME", &self.home)
            .env("PATH", &self.home)
            .env("CC_CANDYBAR_SOCKET", socket)
            .current_dir(&self.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(value) = xdg_state_home {
            cmd.env("XDG_STATE_HOME", value);
        }
        let mut child = cmd.spawn().unwrap();
        let request = json!({"session_id": "feedback", "cwd": self.home});
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&request).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        String::from_utf8(output.stdout).unwrap()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn timeout() -> Option<Value> {
    Some(json!({"ok": false, "code": "TIMEOUT", "error": "fixture"}))
}

// [LAW:behavior-not-structure] Exercise stdout and persisted frames through
// the installed-entry protocol with a private socket and private state.
#[test]
fn absent_daemon_uses_one_waiting_line_until_a_good_frame_is_available() {
    let client = Client::new();
    assert_eq!(client.tick(None, None), WAIT);
    assert!(!client.cache().exists());
    assert_eq!(
        fs::read_to_string(client.state().join("spawn.backoff")).unwrap(),
        "1"
    );

    assert_eq!(
        client.tick(Some(json!({"ok": true, "output": "ready\n"})), None),
        "ready\n"
    );
    assert_eq!(client.tick(None, None), "ready\n");
    assert_eq!(fs::read_to_string(client.cache()).unwrap(), "ready\n");
}

#[test]
fn timeouts_show_a_copyable_hint_and_keep_only_successful_frames() {
    let client = Client::new();
    assert_eq!(client.tick(timeout(), None), DEFAULT_TIMEOUT);
    assert_eq!(client.tick(timeout(), Some("")), DEFAULT_TIMEOUT);
    let untrusted = client.home.join("path with \"quote\"\n\x1b[31m");
    assert_eq!(client.tick(timeout(), untrusted.to_str()), XDG_TIMEOUT);
    assert!(!client.cache().exists());
    assert!(!client.state().exists());
    assert!(!untrusted.exists());

    for frame in ["first row\nsecond row", "new row\n"] {
        assert_eq!(
            client.tick(Some(json!({"ok": true, "output": frame})), None),
            frame
        );
        let expected = format!("{}\n{DEFAULT_TIMEOUT}", frame.trim_end_matches('\n'));
        assert_eq!(client.tick(timeout(), None), expected);
        assert_eq!(fs::read_to_string(client.cache()).unwrap(), frame);
    }
    assert!(!client.state().join("spawn.cooldown").exists());
}
