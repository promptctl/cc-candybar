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

// The frame asks for acts only when told to, and states its length big-endian.
do {
  let plain = frame("cc-candybar://x", actsOn: false)
  let asking = frame("cc-candybar://x", actsOn: true)
  let body = { (d: Data) in
    try! JSONSerialization.jsonObject(with: d.dropFirst(FRAME_HEADER_BYTES)) as! [String: Any]
  }
  expect(Set(body(plain).keys), Set(["kind", "urlV", "url"]), "a plain frame has no actsOn")
  expect(body(asking)["actsOn"] as? String, "desktop", "an asking frame names its place")
  expect(frameLength(plain.prefix(FRAME_HEADER_BYTES)), plain.count - FRAME_HEADER_BYTES, "the header states the body's length")
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
for bad in ["", "-oProxyCommand=x", ".hidden", "a b", "a/b", "*", "!dev", "dev#"] {
  expect(HostAlias(bad) == nil, true, "not an alias: \(bad)")
}

// A forward's file name carries the key and, after it, the alias.
expect(ForwardName(file: "\(id).web.eu-1.sock"), ForwardName(file: "\(id).web.eu-1.sock"), "a name reads")
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

// An editor reaches a path on the host, percent-encoded as a URL path.
expect(
  remoteEditorURL(host: alias, path: "/home/me/my dir/a#b.ts"),
  "vscode://vscode-remote/ssh-remote+web.eu-1/home/me/my%20dir/a%23b.ts",
  "a path with a space and a hash")
expect(remoteEditorURL(host: alias, path: "relative/x"), nil, "a path that is not absolute")

// The verdict: what the daemon said of the link, and the acts the click asked.
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy","text":"hi"},{"kind":"open","target":"/srv/x"}]}"#)),
  Verdict(said: .accepted, acts: [.copy("hi"), .open("/srv/x")]),
  "a verdict with acts, in order")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[]}"#)),
  Verdict(said: .accepted, acts: []),
  "a click that asked for none is not a daemon with no acts key")
expect(
  verdictOf(json(#"{"ok":true,"output":""}"#)),
  Verdict(said: .accepted, acts: nil),
  "a verdict with no acts key")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"burn","x":1},{"kind":"copy"},7]}"#)),
  Verdict(
    said: .accepted,
    acts: [.unknown("burn"), .malformed("a copy with no text"), .malformed("an act with no kind")]),
  "unknown and malformed acts are kept, not dropped")
expect(
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":"copy"}"#)),
  Verdict(said: .accepted, acts: [.malformed("desktopActs is not a list")]),
  "acts that are no list")
expect(
  verdictOf(json(#"{"ok":false,"code":"BAD_REQUEST","error":"no"}"#)),
  Verdict(said: .refused("no"), acts: nil),
  "a refused link")
expect(
  verdictOf(json(#"{"ok":false,"code":"CLOSING","error":"closing"}"#)),
  Verdict(said: .failed("closing"), acts: nil),
  "a daemon that could not take the click")
expect(verdictOf(json("[]")), nil, "bytes that are no verdict")
expect(verdictOf(json("not json")), nil, "bytes that are no JSON")

// What the app does with a verdict.
let accepted = { (acts: [DesktopAct]?) in Verdict(said: .accepted, acts: acts) }
expect(
  steps(for: accepted([.copy("hi"), .open("/srv/x")]), asked: true, host: .alias(alias)),
  [.copy("hi"), .open("vscode://vscode-remote/ssh-remote+web.eu-1/srv/x")],
  "a forwarded copy and open are carried out in order")
expect(steps(for: accepted([.copy("hi")]), asked: false, host: .unnamed), [], "a frame that asked for nothing is carried out as nothing")
expect(
  steps(for: Verdict(said: .refused("no"), acts: nil), asked: true, host: .alias(alias)),
  [],
  "a refused link has no acts to carry out")
do {
  let older = steps(for: accepted(nil), asked: true, host: .alias(alias))
  expect(older.count, 1, "a daemon older than the app is told once")
  if case .tell(let why) = older[0] {
    expect(why.contains("update cc-candybar there and restart its daemon"), true, "and told what to do")
  } else {
    expect(false, true, "and told, not carried out")
  }
}
for host in [ForwardHost.unnamed, .malformed("-x")] {
  let said = steps(for: accepted([.copy("hi"), .open("/srv/x")]), asked: true, host: host)
  expect(said.count, 2, "an open with no usable host still lets the copy through: \(host)")
  expect(said[0], .copy("hi"), "the copy is carried out: \(host)")
  if case .tell(let why) = said[1] {
    expect(why.contains("/srv/x"), true, "the open names what it could not reach: \(host)")
  } else {
    expect(false, true, "an open with no usable host is told: \(host)")
  }
}
for act in [DesktopAct.unknown("burn"), .malformed("a copy with no text")] {
  let said = steps(for: accepted([act]), asked: true, host: .alias(alias))
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
