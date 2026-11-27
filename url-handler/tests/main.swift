// What the URL handler decides, stated as expectations over wire.swift's pure
// reads. Run by `url-handler/check.sh`; any failure ends the run non-zero.
// [LAW:verifiable-goals] The socket and AppKit halves of the app are not here:
// they carry out what these decide.

import Foundation

var failures = 0

func expect<T: Equatable>(_ got: T, _ want: T, _ what: String) {
  if got != want {
    failures += 1
    print("FAIL \(what)\n  got:  \(got)\n  want: \(want)")
  }
}

func json(_ text: String) -> Data { text.data(using: .utf8)! }

let id = "AbCd-_12"
let alias = HostAlias("web.eu-1")!

// Every frame names where its click's acts go, and states its length big-endian.
do {
  let own = frame("cc-candybar://x", actsOn: ACTS_ON_DAEMON)
  let forwarded = frame("cc-candybar://x", actsOn: ACTS_ON_DESKTOP)
  let body = { (d: Data) in
    try! JSONSerialization.jsonObject(with: d.dropFirst(FRAME_HEADER_BYTES)) as! [String: Any]
  }
  expect(Set(body(own).keys), Set(["kind", "urlV", "url", "actsOn"]), "a frame's fields")
  expect(body(own)["actsOn"] as? String, "daemon", "a frame for this Mac's daemon names the daemon")
  expect(body(forwarded)["actsOn"] as? String, "desktop", "a forwarded frame names the desktop")
  expect(frameLength(own.prefix(FRAME_HEADER_BYTES)), own.count - FRAME_HEADER_BYTES, "the header states the body's length")
}

// A link names its signer in the first field of its proof, and no other spelling.
expect(keyId(of: "cc-candybar://copy?t=x#\(id)/abc"), id, "a link's signer")
expect(keyId(of: "cc-candybar://copy?t=x#abc/abc"), nil, "an id too short")
expect(keyId(of: "cc-candybar://copy?t=x#../../etc/x/abc"), nil, "an id that is a path")
expect(keyId(of: "cc-candybar://copy?t=x#\(id)"), nil, "a proof with no separator")
expect(keyId(of: "cc-candybar://copy?t=x"), nil, "a link with no proof")

// A host alias is what ssh's config names, in a spelling a file name carries.
expect(HostAlias("web.eu-1") != nil, true, "an alias with dots and dashes")
expect(HostAlias("_x") != nil, true, "an alias starting with _")
expect(HostAlias(String(repeating: "a", count: HOST_ALIAS_MAX_CHARS)) != nil, true, "an alias as long as a path allows")
expect(HostAlias(String(repeating: "a", count: HOST_ALIAS_MAX_CHARS + 1)) == nil, true, "an alias too long for a socket's path")
for bad in ["", "-oProxyCommand=x", ".hidden", "a b", "a/b", "*", "!dev", "dev#"] {
  expect(HostAlias(bad) == nil, true, "not an alias: \(bad)")
}

// A forward's file name carries the key and, after it, the alias.
expect(ForwardName(file: "\(id).web.eu-1.sock")?.keyId, id, "the key before the alias")
expect(ForwardName(file: "\(id).web.eu-1.sock")?.host, .alias(alias), "the alias after the key")
expect(ForwardName(file: "\(id).sock")?.host, .unnamed, "a name with no alias")
expect(ForwardName(file: "\(id)..sock")?.host, .malformed(""), "an empty alias is malformed")
expect(ForwardName(file: "\(id).-x.sock")?.host, .malformed("-x"), "an alias starting with - is malformed")
expect(ForwardName(file: "\(id)web.sock") == nil, true, "no separator after the key is no forward's name")
expect(ForwardName(file: "\(id).web") == nil, true, "no suffix is no forward's name")
expect(ForwardName(file: "short.sock") == nil, true, "a short key is no forward's name")

// Of the forwards naming a key, the newest takes the link.
do {
  func entry(_ file: String, _ at: TimeInterval) -> ForwardEntry {
    ForwardEntry(file: file, name: ForwardName(file: file)!, modified: Date(timeIntervalSince1970: at))
  }
  let old = entry("\(id).old.sock", 1)
  let new = entry("\(id).new.sock", 2)
  let other = entry("Zz9-_abc.other.sock", 3)
  expect(newestForward(naming: id, among: [new, old, other]), new, "the newest forward naming the key")
  expect(newestForward(naming: id, among: [other]), nil, "no forward naming the key")
  expect(newestForward(naming: id, among: []), nil, "no forwards")
}

// Where a link goes: the forward its signer's key names, else this Mac's daemon.
do {
  let own = "/tmp/own"
  let dir = "/home/.fwd"
  let link = "cc-candybar://copy?t=x#\(id)/abc"
  let none: () -> Directory = { fatalError("a link that names no signer lists no directory") }
  let route = { (listing: Directory, inspect: @escaping (String) -> Inspection) in
    routeOf(link, own: own, directory: dir, listing: { listing }, inspect: inspect)
  }
  let at = { (t: TimeInterval) in Inspection.modified(Date(timeIntervalSince1970: t)) }

  expect(
    routeOf("cc-candybar://copy?t=x", own: own, directory: dir, listing: none, inspect: { _ in .vanished }),
    .success(.own(socket: own)), "a link that names no signer goes to this Mac's daemon")
  expect(route(.absent, { _ in .vanished }), .success(.own(socket: own)), "a Mac with no forwards directory")
  expect(route(.files([]), { _ in .vanished }), .success(.own(socket: own)), "a directory with no forwards")
  expect(
    route(.files(["Zz9-_abc.web.sock", "notes.txt"]), { _ in at(1) }),
    .success(.own(socket: own)), "forwards that name another key")
  expect(
    route(.files(["\(id).web.sock"]), { _ in .vanished }),
    .success(.own(socket: own)), "a forward that vanished after the listing is no forward")
  expect(
    route(.files(["\(id).old.sock", "\(id).new.sock"]), { $0.contains("new") ? at(2) : at(1) }),
    .success(.forward(entry: ForwardEntry(
      file: "\(id).new.sock", name: ForwardName(file: "\(id).new.sock")!,
      modified: Date(timeIntervalSince1970: 2)), socket: "\(dir)/\(id).new.sock")),
    "the newest forward naming the key, at its path")
  expect(
    route(.unreadable("denied"), { _ in .vanished }),
    .failure(ForwardError("cannot read the ssh forwards in \(dir): denied")),
    "a directory that cannot be read is told, not read as no forwards")
  expect(
    route(.files(["\(id).web.sock"]), { _ in .unreadable("denied") }),
    .failure(ForwardError("cannot inspect the ssh forward \(dir)/\(id).web.sock: denied")),
    "a forward that cannot be inspected is told, not read as no forward")
  expect(Route.own(socket: own).actsOn, "daemon", "a link sent to this Mac's daemon asks for nothing")
  expect(
    Route.forward(entry: ForwardEntry(file: "\(id).sock", name: ForwardName(file: "\(id).sock")!, modified: Date()), socket: "x").actsOn,
    "desktop", "a link sent down a forward asks for its acts here")
}

// An editor reaches a path on the host, percent-encoded as a URL path.
expect(
  remoteEditorURL(host: alias, path: "/home/me/my dir/a#b.ts", file: true),
  "vscode://vscode-remote/ssh-remote+web.eu-1/home/me/my%20dir/a%23b.ts:1",
  "a path with a space and a hash")
expect(remoteEditorURL(host: alias, path: "relative/x", file: false), nil, "a path that is not absolute")

// The verdict: what the daemon said of the link, and the acts the click asked.
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy","text":"hi"},{"kind":"open","target":"/srv/x","file":false}]}"#)),
  .accepted(acts: [.copy("hi"), .open("/srv/x", file: false)]),
  "a verdict with acts, in order")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[]}"#)),
  .accepted(acts: []),
  "a click that asked for none is not a daemon with no acts key")
expect(
  verdictOf(json(#"{"ok":true,"output":""}"#)),
  .accepted(acts: nil),
  "a verdict with no acts key")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"burn","x":1},{"kind":"copy"},7]}"#)),
  .accepted(acts: [.unknown("burn"), .malformed("a copy with no text"), .malformed("an act with no kind")]),
  "unknown and malformed acts are kept, not dropped")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":"copy"}"#)),
  .accepted(acts: [.malformed("desktopActs is not a list")]),
  "acts that are no list")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":"copy","desktopError":"boom"}"#)),
  .accepted(acts: [.malformed("desktopActs is not a list"), .failed("boom")]),
  "a failure beside acts that are no list is kept")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[],"desktopError":7}"#)),
  .accepted(acts: [.malformed("desktopError is not a string")]),
  "a failure that is no string is told, not dropped")
expect(
  verdictOf(json(#"{"ok":false,"code":"BAD_REQUEST","error":"no"}"#)),
  .refused("no"),
  "a refused link")
expect(
  verdictOf(json(#"{"ok":false,"code":"CLOSING","error":"closing"}"#)),
  .failed("closing"),
  "a daemon that could not take the click")
expect(verdictOf(json(#"{"ok":false,"code":"BAD_REQUEST"}"#)), nil, "a failure that says no reason is no verdict")
expect(verdictOf(json("[]")), nil, "bytes that are no verdict")
expect(verdictOf(json("not json")), nil, "bytes that are no JSON")

// What the app does with a verdict's acts, by where the click was sent.
func forwardVia(_ file: String) -> Route {
  .forward(
    entry: ForwardEntry(file: file, name: ForwardName(file: file)!, modified: Date()),
    socket: "/fwd/\(file)")
}
let named = forwardVia("\(id).web.eu-1.sock")
let partial = verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy","text":"hi"}],"desktopError":"cannot open the remote file"}"#))
if case .accepted(let acts) = partial {
  expect(steps(for: acts, via: named), [.copy("hi"), .clickFailed("cannot open the remote file")], "successful acts and a partial failure both reach the writer")
} else { expect(false, true, "expected the partial result") }

// A click that asked no act and then failed is the same verdict as one that
// asked some: the link was taken, so it is neither a refusal nor a dead forward.
let failedAlone = verdictOf(json(#"{"ok":true,"output":"","desktopActs":[],"desktopError":"copy-diagnostic: unknown renderer"}"#))
expect(failedAlone, .accepted(acts: [.failed("copy-diagnostic: unknown renderer")]), "a click that asked nothing and failed is a taken link with its failure")
if case .accepted(let acts) = failedAlone {
  expect(steps(for: acts, via: named), [.clickFailed("copy-diagnostic: unknown renderer")], "and its failure is told as the click's, not taken for the forward's")
}
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopError":"boom"}"#)),
  .accepted(acts: [.malformed("desktopActs is missing"), .failed("boom")]),
  "a failure with no acts key is not an older daemon's verdict")

// What a verdict comes to for the person: only a frame that never reached the
// daemon is a forward that took nothing.
expect(told(.accepted(acts: [])), .delivered(acts: []), "a taken link")
expect(told(.refused("no")), .refused("no"), "a refused link")
expect(told(.failed("no renderer")), .daemonFailed("no renderer"), "a failure the daemon said is the daemon's, not the forward's")

expect(
  steps(for: [.copy("hi"), .open("/srv/x", file: false)], via: named),
  [.copy("hi"), .open("vscode://vscode-remote/ssh-remote+web.eu-1/srv/x/")],
  "a forwarded copy and open are carried out in order")
expect(
  steps(for: [.copy("hi")], via: .own(socket: "/tmp/own")), [],
  "a click this Mac's own daemon took acted here already")
expect(steps(for: nil, via: .own(socket: "/tmp/own")), [], "and a daemon with no acts key has nothing to be older about")
do {
  let older = steps(for: nil, via: named)
  expect(older.count, 1, "a daemon older than the app is told once")
  if case .tell(let why) = older[0] {
    expect(why.contains("update cc-candybar there and restart its daemon"), true, "and told what to do")
    expect(why.contains("happened there, not here"), true, "and told where its copy or open went")
  } else {
    expect(false, true, "and told, not carried out")
  }
}
for file in ["\(id).sock", "\(id).-x.sock"] {
  let said = steps(for: [.copy("hi"), .open("/srv/x", file: false)], via: forwardVia(file))
  expect(said.count, 2, "an open with no usable host still lets the copy through: \(file)")
  expect(said[0], .copy("hi"), "the copy is carried out: \(file)")
  if case .tell(let why) = said[1] {
    expect(why.contains("/srv/x"), true, "the open names what it could not reach: \(file)")
  } else {
    expect(false, true, "an open with no usable host is told: \(file)")
  }
}
for act in [DesktopAct.unknown("burn"), .malformed("a copy with no text")] {
  let said = steps(for: [act], via: named)
  if case .tell = said.first {
  } else {
    expect(false, true, "an act the app cannot carry out is told: \(act)")
  }
}

if failures > 0 {
  print("url-handler: \(failures) expectation(s) failed")
  exit(1)
}
print("url-handler: all expectations hold")
