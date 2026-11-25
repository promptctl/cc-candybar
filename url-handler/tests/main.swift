// The URL handler's wire reads (../wire.swift), run by ../check.sh: every
// expectation is a fact the app reads off a link, a directory listing or a
// verdict. It exits non-zero, naming each one that does not hold.

import Foundation

var failures: [String] = []

func expect<T: Equatable>(_ actual: T, _ expected: T, _ what: String) {
  if actual != expected {
    failures.append("\(what): expected \(expected), got \(actual)")
  }
}

func json(_ text: String) -> Data { text.data(using: .utf8)! }

let dir = "/Users/x/.cc-candybar/remote"
let id = "AbCd-_12"

// --- the signer a link names ---------------------------------------------

expect(signerId(of: "cc-candybar://copy/x#\(id)/mac"), id, "a link names its signer")
expect(signerId(of: "cc-candybar://copy/x#mac"), nil, "a proof with no signer field")
expect(signerId(of: "cc-candybar://copy/x#short/mac"), nil, "an id of the wrong length")
expect(signerId(of: "cc-candybar://copy/x#../../ab/mac"), nil, "an id that is a path")
expect(signerId(of: "cc-candybar://copy/x"), nil, "a link with no proof")

// --- the forwards an id names --------------------------------------------

expect(
  forwardsIn(
    names: ["\(id).devbox.sock", "\(id).sock", "OTHER123.devbox.sock", "\(id).a.b.sock", "notes.txt"],
    id: id, dir: dir),
  [
    Forwarded(socket: "\(dir)/\(id).a.b.sock", host: .named(HostAlias("a.b")!)),
    Forwarded(socket: "\(dir)/\(id).devbox.sock", host: .named(HostAlias("devbox")!)),
    Forwarded(socket: "\(dir)/\(id).sock", host: .unnamed),
  ],
  "the files an id names, in name order, with the host each carries")
expect(
  forwardsIn(names: ["\(id)..sock", "\(id).a b.sock", "\(id).-x.sock"], id: id, dir: dir),
  [
    Forwarded(socket: "\(dir)/\(id).-x.sock", host: .malformed("-x")),
    Forwarded(socket: "\(dir)/\(id).a b.sock", host: .malformed("a b")),
  ],
  "a host no ssh-config stanza writes is malformed, never a host (and an empty one is no file of this id)")
expect(forwardsIn(names: ["\(id)Xdevbox.sock"], id: id, dir: dir), [], "an id is not a prefix of another")

// --- where a click's acts go ---------------------------------------------

expect(Route.own(socket: "/tmp/s").place, .daemon, "this Mac's own daemon acts here")
expect(
  Route.forward(id: id, via: []).place, .desktop, "a daemon behind a forward hands its acts back")
expect(Route.unreadable("x").place, .daemon, "an unreadable directory asks nothing of the app")
expect(Route.forward(id: id, via: []).queueKey, id, "clicks to one forwarded daemon share a queue")

// --- the frame -----------------------------------------------------------

func bodyOf(_ frame: Data) -> [String: Any] {
  let body = frame.dropFirst(FRAME_HEADER_BYTES)
  return try! JSONSerialization.jsonObject(with: body) as! [String: Any]
}
let own = frame("cc-candybar://x", place: .daemon)
let forwarded = frame("cc-candybar://x", place: .desktop)
expect(Array(own.prefix(FRAME_HEADER_BYTES)), [0, 0, 0, UInt8(own.count - FRAME_HEADER_BYTES)], "the length header")
expect(bodyOf(own)["actsOn"] == nil, true, "a frame to this Mac's daemon asks nothing")
expect(bodyOf(forwarded)["actsOn"] as? String, ACTS_ON_DESKTOP, "a frame down a forward asks for the acts")
expect(bodyOf(forwarded)["urlV"] as? Int, URL_FRAME_VERSION, "the frame's version")

// --- the verdict ---------------------------------------------------------

expect(
  verdictOf(json(#"{"ok":true,"output":""}"#), place: .daemon), .delivered([]),
  "a link that opened, for a daemon that acts on its own machine")
expect(
  verdictOf(
    json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy","text":"a"},{"kind":"open","target":"/w"}]}"#),
    place: .desktop),
  .delivered([.copy("a"), .open("/w")]),
  "the acts a click handed back, in the order asked")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[]}"#), place: .desktop), .delivered([]),
  "a click that asked none")
if case .unread = verdictOf(json(#"{"ok":true,"output":""}"#), place: .desktop) {
} else {
  failures.append("a daemon that hands no acts back is said, not read as a click that asked none")
}
if case .unread = verdictOf(
  json(#"{"ok":true,"output":"","desktopActs":[{"kind":"paste","text":"a"}]}"#), place: .desktop)
{
} else {
  failures.append("an act this app does not know is said, not dropped")
}
expect(
  verdictOf(
    json(#"{"ok":false,"error":"boom","code":"RENDER_FAILED","desktopActs":[{"kind":"copy","text":"k"}]}"#),
    place: .desktop),
  .clickFailed("boom", [.copy("k")]),
  "a click that failed after asking a copy still hands the copy back")
expect(
  verdictOf(json(#"{"ok":false,"error":"forged","code":"BAD_REQUEST"}"#), place: .desktop),
  .refused("forged", []), "a link the daemon refused, from a daemon that hands no acts back")
expect(
  verdictOf(
    json(#"{"ok":false,"error":"no","code":"BAD_REQUEST","desktopActs":[]}"#), place: .desktop),
  .refused("no", []), "a refusal is a refusal whether or not its verdict lists acts")
expect(
  verdictOf(
    json(#"{"ok":false,"error":"no","code":"BAD_REQUEST","desktopActs":[{"kind":"open","target":"/w"}]}"#),
    place: .desktop),
  .refused("no", [.open("/w")]), "a refusal after an act still hands the act back")
expect(
  verdictOf(json(#"{"ok":false,"error":"closing","code":"RENDER_FAILED"}"#), place: .daemon),
  .clickFailed("closing", []), "a daemon that failed")
expect(
  verdictOf(
    json(#"{"ok":false,"error":"x","code":"RENDER_FAILED","desktopActs":[{"kind":"paste"}]}"#),
    place: .desktop),
  .clickFailed("x; its copy and open acts were not read: an act this app does not know: [\"kind\": paste]; is the app older than the daemon?", []),
  "a failure whose acts cannot be read says so beside its own reason")
if case .unconfirmed = verdictOf(json("not json"), place: .daemon) {
} else {
  failures.append("a verdict that is not JSON is unconfirmed")
}

// --- the editor's link ---------------------------------------------------

expect(
  remoteEditorURL(host: HostAlias("dev.example-1")!, path: "/work/my repo")?.absoluteString,
  "vscode://vscode-remote/ssh-remote+dev.example-1/work/my%20repo",
  "an editor link names the remote by the host the person typed")
expect(HostAlias("me@box"), nil, "a user is not a host alias")
expect(HostAlias("*"), nil, "a pattern is not a host alias")
expect(HostAlias("."), nil, "a dot is not a host alias")
expect(HostAlias("-dev"), nil, "an option is not a host alias")

if failures.isEmpty {
  print("url handler wire: all expectations hold")
} else {
  for failure in failures { FileHandle.standardError.write(Data((failure + "\n").utf8)) }
  exit(1)
}
