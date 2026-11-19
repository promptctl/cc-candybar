use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[test]
fn cold_and_steady_statusline_ticks_send_the_environment_only_on_request() {
    // Unix socket paths have a low length limit on macOS, including in CI.
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let home =
        std::path::Path::new("/tmp").join(format!("ccb-wire-{}-{nonce}", std::process::id()));
    fs::create_dir(&home).unwrap();
    let socket = home.join("host.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for reply in [
            json!({"ok": true, "need": "environment"}),
            json!({"ok": true, "output": "cold"}),
            json!({"ok": true, "output": "steady"}),
        ] {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut length = [0; 4];
            stream.read_exact(&mut length).unwrap();
            let length = u32::from_be_bytes(length) as usize;
            assert!((1..=65536).contains(&length));
            let mut body = vec![0; length];
            stream.read_exact(&mut body).unwrap();
            tx.send(serde_json::from_slice::<Value>(&body).unwrap())
                .unwrap();
            let bytes = serde_json::to_vec(&reply).unwrap();
            stream
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    for expected in ["cold", "steady"] {
        let mut client = Command::new(env!("CARGO_BIN_EXE_cc-candybar"))
            .current_dir(&home)
            .env_clear()
            .env("HOME", &home)
            .env("CC_CANDYBAR_SOCKET", &socket)
            .env("SSH_CONNECTION", "wire-fixture")
            .env("COLUMNS", "96")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let hook = json!({"session_id": "wire", "cwd": home});
        client
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&hook).unwrap())
            .unwrap();
        let out = client.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            std::str::from_utf8(&out.stdout).unwrap().trim_end(),
            expected
        );
    }
    let probe = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let full = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let steady = rx.recv_timeout(Duration::from_secs(2)).unwrap();
    for tick in [&probe, &steady] {
        assert_eq!(tick["kind"], "render-session");
        assert_eq!(tick["termCols"], 96);
        assert!(tick.get("env").is_none());
        assert_eq!(tick["envKey"], full["envKey"]);
    }
    assert_eq!(full["kind"], "render");
    assert_eq!(full["env"]["SSH_CONNECTION"], "wire-fixture");
    assert!(full.get("ssh").is_none());
    assert_eq!(probe["deadline"], full["deadline"]);
    fs::remove_dir_all(home).unwrap();
}
