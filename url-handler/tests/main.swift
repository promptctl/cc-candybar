// The URL handler's pure reads, against the daemon's own spellings. Run by
// `url-handler/check.sh`: swiftc, one process, a nonzero exit on the first
// expectation that fails, each named by what it expects.

import Foundation

var failures = 0

func expect<T: Equatable>(_ what: String, _ got: T, _ want: T) {
  if got == want { return }
  failures += 1
  print("FAIL \(what)\n  got:  \(got)\n  want: \(want)")
}

func json(_ text: String) -> Data { Data(text.utf8) }

let id = "AbCd-_12"
let link = "cc-candybar://copy/hello#\(id)/c2ln"

// --- the frame ---------------------------------------------------------------

func body(of framed: Data) -> [String: Any] {
  let json = framed.dropFirst(FRAME_HEADER_BYTES)
  return try! JSONSerialization.jsonObject(with: Data(json)) as! [String: Any]
}

let plain = frame(link, actsOnDesktop: false)
expect(
  "the header is the body's length, big-endian",
  plain.prefix(FRAME_HEADER_BYTES).reduce(0) { ($0 << 8) | Int($1) }, plain.count - FRAME_HEADER_BYTES)
expect("a local link's frame names no place", body(of: plain)["actsOn"] == nil, true)
expect("a frame carries the link", body(of: plain)["url"] as? String, link)
expect("a frame carries its version", body(of: plain)["urlV"] as? Int, URL_FRAME_VERSION)
expect(
  "a forwarded link's frame asks for its acts on this machine",
  body(of: frame(link, actsOnDesktop: true))["actsOn"] as? String, ACTS_ON_DESKTOP)

expect("the socket is derived from the uid", socketPath(uid: 501), "/tmp/cc-candybar-501/socket")

// --- which daemon signed a link ------------------------------------------------

expect("a link names its signer", signerId(of: link), id)
expect("a proof with no id names none", signerId(of: "cc-candybar://copy/x#c2ln"), nil)
expect("an id of the wrong length names none", signerId(of: "cc-candybar://copy/x#abc/c2ln"), nil)
expect("an id outside the alphabet names none", signerId(of: "cc-candybar://copy/x#../../etc/c2ln"), nil)
expect("an id with a character outside the alphabet names none", signerId(of: "cc-candybar://copy/x#AbCd._12/c2ln"), nil)

// --- the forward's name ----------------------------------------------------------

expect("a forward names its signer and its host", forwardName("\(id).devbox.sock"), ForwardName(id: id, host: HostAlias("devbox")))
expect("a host may hold dots and dashes", forwardName("\(id).dev-1.example.com.sock"), ForwardName(id: id, host: HostAlias("dev-1.example.com")))
expect("a forward with no host is the older name", forwardName("\(id).sock"), ForwardName(id: id, host: nil))
expect("a name that is not a socket is none", forwardName("\(id).devbox.txt"), nil)
expect("a host that leads with a dot is none", forwardName("\(id)..devbox.sock"), nil)
expect("a host with a slash is none", forwardName("\(id).a/b.sock"), nil)
expect("a name with no separator after the id is none", forwardName("\(id)devbox.sock"), nil)
expect("a short name is none", forwardName("abc.sock"), nil)

let older = Date(timeIntervalSince1970: 100)
let newer = Date(timeIntervalSince1970: 200)
expect(
  "of two files for one signer, the newer is the forward",
  forwardFile(for: id, among: [("\(id).old.sock", older), ("\(id).new.sock", newer), ("ZZZZZZZZ.x.sock", newer)])?.file,
  "\(id).new.sock")
expect(
  "no file for a signer is no forward",
  forwardFile(for: id, among: [("ZZZZZZZZ.x.sock", newer)])?.file, nil)

// --- the daemon's verdict ------------------------------------------------------

expect(
  "a click that landed, with the copy it handed back",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy","text":"hello"}]}"#)),
  Verdict(said: .delivered, acts: [.copy("hello")]))
expect(
  "a click that failed after asking an open still hands it back",
  verdictOf(json(#"{"ok":false,"error":"boom","code":"RENDER_FAILED","desktopActs":[{"kind":"open","target":"/srv/x"}]}"#)),
  Verdict(said: .failed("boom"), acts: [.open("/srv/x")]))
expect(
  "a refused click is told as refused, with no acts to read",
  verdictOf(json(#"{"ok":false,"error":"not drawn","code":"BAD_REQUEST"}"#)),
  Verdict(said: .refused("not drawn"), acts: nil))
expect(
  "a landed click that handed back none is told as none, not as absent",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[]}"#)),
  Verdict(said: .delivered, acts: []))
expect("a verdict that is not JSON is none", verdictOf(json("nope")), nil)
expect("a verdict with no ok is none", verdictOf(json(#"{"output":""}"#)), nil)
expect(
  "an act this app does not know is carried as unknown",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"teleport"}]}"#))?.acts,
  [.unknown("teleport")])
expect(
  "a copy with no text is malformed, not unknown",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"copy"}]}"#))?.acts,
  [.malformed("a copy with no text")])
expect(
  "an open with no target is malformed",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":[{"kind":"open","text":"x"}]}"#))?.acts,
  [.malformed("an open with no target")])
expect(
  "acts that are not a list are malformed",
  verdictOf(json(#"{"ok":true,"output":"","desktopActs":"copy"}"#))?.acts,
  [.malformed("acts that are not a list")])

// --- what is done for an act ---------------------------------------------------

expect("a copy is copied here", plan([.copy("hi")], host: HostAlias("devbox")), [.copy("hi")])
expect("a copy needs no host", plan([.copy("hi")], host: nil), [.copy("hi")])
expect(
  "an open is the editor's remote link for that host and path",
  plan([.open("/srv/my project")], host: HostAlias("devbox")),
  [.open(URL(string: "vscode://vscode-remote/ssh-remote+devbox/srv/my%20project")!)])
expect("an open with no host cannot be carried out", { () -> Bool in
  if case .cannot(let why) = plan([.open("/srv/x")], host: nil)[0] { return why.contains("names no host") }
  return false
}(), true)
expect("an open of a relative path cannot be carried out", { () -> Bool in
  if case .cannot(let why) = plan([.open("srv/x")], host: HostAlias("devbox"))[0] { return why.contains("not an absolute path") }
  return false
}(), true)
expect("an act that is not known is told", { () -> Bool in
  if case .cannot(let why) = plan([.unknown("teleport")], host: HostAlias("devbox"))[0] { return why.contains("teleport") }
  return false
}(), true)

expect("an act that is malformed is told", { () -> Bool in
  if case .cannot(let why) = plan([.malformed("a copy with no text")], host: nil)[0] { return why.contains("a copy with no text") }
  return false
}(), true)

// --- a verdict, as the acts it asked for are read ------------------------------

let landed = Verdict(said: .delivered, acts: [.copy("x")])
expect("a verdict's acts are what is done", steps(for: landed, asked: true, host: nil), [.copy("x")])
expect(
  "a daemon that was asked and sent no acts key is told, not read as none", { () -> Bool in
    let steps = steps(for: Verdict(said: .delivered, acts: nil), asked: true, host: nil)
    if case .cannot(let why)? = steps.first { return steps.count == 1 && why.contains("older") }
    return false
  }(), true)
expect(
  "a verdict with no acts key is nothing to do for a click that did not ask",
  steps(for: Verdict(said: .delivered, acts: nil), asked: false, host: nil), [])
expect(
  "a refusal with no acts key is nothing to carry out, whatever was asked",
  steps(for: Verdict(said: .refused("no"), acts: nil), asked: true, host: nil), [])

// --- a host alias is one word, parsed ------------------------------------------

expect("an alias is letters, digits, dots and dashes", HostAlias("dev-1.example")?.word, "dev-1.example")
expect("an alias does not begin with a dot", HostAlias(".dev"), nil)
expect("an alias is not empty", HostAlias(""), nil)
expect("an alias has no space", HostAlias("my box"), nil)
expect("an alias has no +", HostAlias("web+eu"), nil)

if failures > 0 {
  print("\(failures) expectation(s) failed")
  exit(1)
}
print("url-handler: all expectations hold")
