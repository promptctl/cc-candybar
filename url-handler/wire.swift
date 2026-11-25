// What the URL handler knows of the wire, as pure reads: no socket, no
// pasteboard, no editor. main.swift does the I/O, and url-handler/tests runs
// these against the daemon's own spellings (`check.sh`).
//
// [LAW:one-source-of-truth] Every literal here is mirrored from
// src/daemon/foundations/protocol.ts, src/daemon/paths.ts or
// src/click/link-signer.ts and pinned by scripts/check-protocol.mjs.
//
// [LAW:effects-at-boundaries] A click that lands on a forward is carried out
// here, on the machine the person sits at: what the daemon hands back is data
// (`DesktopAct`), and what to do with it is decided here, by `steps`, before
// any of it touches the Mac.

import Foundation

let FRAME_HEADER_BYTES = 4
// The longest frame either side writes; a verdict carries the text a copy asks
// for, so the app reads as much as the daemon sends.
let FRAME_MAX_BYTES = 16 * 1024 * 1024
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 2
// Where a click's copy and open act: on this machine, not the daemon's. Sent
// only for a link a forward carries, so a local click acts as it always did.
let ACTS_ON_DESKTOP = "desktop"

// The verdict's key for the acts a click left to this machine, and the spelling
// of each act.
let DESKTOP_ACTS_KEY = "desktopActs"
enum DesktopActWire {
  static let kind = "kind"
  static let copy = "copy"
  static let open = "open"
  static let text = "text"
  static let target = "target"
}

let REMOTE_SOCKET_DIR_UNDER_HOME = ".cc-candybar/remote"
let REMOTE_SOCKET_SUFFIX = ".sock"
let REMOTE_SOCKET_HOST_SEPARATOR = "."
let HOST_ALIAS_FIRST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
let HOST_ALIAS_REST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-"

let LINK_KEY_ID_CHARS = 8
let LINK_KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
let LINK_MAC_MARK: Character = "#"
let LINK_PROOF_SEPARATOR: Character = "/"

// VS Code's remote-over-ssh handler: `vscode://vscode-remote/ssh-remote+<host><path>`.
let REMOTE_EDITOR_SCHEME = "vscode"
let REMOTE_EDITOR_AUTHORITY = "vscode-remote"
let REMOTE_EDITOR_PATH_PREFIX = "/ssh-remote+"

// The daemon's socket for this account: derived from the uid, because Launch
// Services starts the app with no shell's environment.
func socketPath(uid: uid_t) -> String {
  "/tmp/cc-candybar-\(uid)/socket"
}

// The frame for one link: a 4-byte big-endian length, then the JSON body.
func frame(_ url: String, actsOnDesktop: Bool) -> Data {
  let fields: [String: Any?] = [
    "kind": URL_FRAME_KIND, "urlV": URL_FRAME_VERSION, "url": url,
    "actsOn": actsOnDesktop ? ACTS_ON_DESKTOP : nil,
  ]
  // [LAW:no-silent-failure] exception: a dictionary of strings and one integer
  // has no JSON encoding that fails, so there is no failure to carry.
  let body = try! JSONSerialization.data(
    withJSONObject: fields.compactMapValues { $0 }, options: [.sortedKeys])
  var header = UInt32(body.count).bigEndian
  var data = Data(bytes: &header, count: FRAME_HEADER_BYTES)
  data.append(body)
  return data
}

// The id a link names as its signer, or nil for a link that names none (a
// proof that does not begin with one, as links drawn before they named a
// signer do not). The link comes from any web page, and the id becomes part of
// a path, so it is the spelling the signer writes and nothing else.
func signerId(of link: String) -> String? {
  guard let mark = link.lastIndex(of: LINK_MAC_MARK) else { return nil }
  let proof = link[link.index(after: mark)...]
  guard let slash = proof.firstIndex(of: LINK_PROOF_SEPARATOR) else { return nil }
  return keyId(String(proof[..<slash]))
}

// [LAW:single-enforcer] A key id as the signer spells it, for a link's proof and
// a forward's file name alike: the one place the length and alphabet are read.
func keyId(_ word: String) -> String? {
  guard word.utf8.count == LINK_KEY_ID_CHARS, word.allSatisfy({ LINK_KEY_ID_ALPHABET.contains($0) })
  else { return nil }
  return word
}

// [LAW:parse-dont-validate] A host alias: one word of ssh's config that names
// one host, spelled so a file name can carry it, in the alphabet the stanza's
// `Host` line was checked against and nothing wider. The only way to hold one
// is to parse it, so the editor's link is built from nothing else.
struct HostAlias: Equatable {
  let word: String

  init?(_ word: String) {
    guard let first = word.first, HOST_ALIAS_FIRST.contains(first),
      word.dropFirst().allSatisfy({ HOST_ALIAS_REST.contains($0) })
    else { return nil }
    self.word = word
  }
}

// A forward the user's ssh made: `<id>.<host>.sock`, or the older `<id>.sock`
// that names no host. A name that is neither is not a forward of this app's.
struct ForwardName: Equatable {
  let id: String
  let host: HostAlias?
}

func forwardName(_ file: String) -> ForwardName? {
  guard file.hasSuffix(REMOTE_SOCKET_SUFFIX) else { return nil }
  let stem = String(file.dropLast(REMOTE_SOCKET_SUFFIX.count))
  guard let id = keyId(String(stem.prefix(LINK_KEY_ID_CHARS))) else { return nil }
  let rest = stem.dropFirst(LINK_KEY_ID_CHARS)
  if rest.isEmpty { return ForwardName(id: id, host: nil) }
  guard rest.hasPrefix(REMOTE_SOCKET_HOST_SEPARATOR) else { return nil }
  guard let host = HostAlias(String(rest.dropFirst(REMOTE_SOCKET_HOST_SEPARATOR.count))) else {
    return nil
  }
  return ForwardName(id: id, host: host)
}

// The forward a link's signer is reached by: of the files naming that id, the
// one ssh made last. Two aliases of one machine make two files for one daemon,
// and a file outlives the ssh that made it, so the newest is the one a live
// connection most likely holds. A forward that is not live says so when the
// link is sent through it, naming the forward.
func forwardFile(for id: String, among files: [(name: String, modified: Date)]) -> (
  file: String, name: ForwardName
)? {
  files
    .compactMap { entry in forwardName(entry.name).map { (entry.name, $0, entry.modified) } }
    .filter { $0.1.id == id }
    .max { $0.2 < $1.2 }
    .map { ($0.0, $0.1) }
}

// A copy or open the daemon asked of this machine. An act this app cannot read
// is carried as what it is, so it is told, never dropped. [LAW:no-silent-failure]
enum DesktopAct: Equatable {
  case copy(String)
  case open(String)
  // A kind this app does not know: a newer daemon's.
  case unknown(String)
  // A kind it knows, without the field it is carried out by.
  case malformed(String)
}

enum Said: Equatable {
  case delivered
  // The daemon refused the click, for the reason it gave.
  case refused(String)
  // The daemon failed the click (it was closing), for the reason it gave.
  case failed(String)
}

// The daemon's verdict on a click. `acts` is nil when the verdict has no
// `desktopActs` at all, which is not a verdict of none: a daemon that was asked
// for the acts and sent no key does not know the question.
struct Verdict: Equatable {
  let said: Said
  let acts: [DesktopAct]?
}

private func desktopAct(_ raw: Any) -> DesktopAct {
  guard let act = raw as? [String: Any], let kind = act[DesktopActWire.kind] as? String else {
    return .malformed("an act with no kind")
  }
  switch kind {
  case DesktopActWire.copy:
    guard let text = act[DesktopActWire.text] as? String else { return .malformed("a copy with no text") }
    return .copy(text)
  case DesktopActWire.open:
    guard let target = act[DesktopActWire.target] as? String else { return .malformed("an open with no target") }
    return .open(target)
  default:
    return .unknown(kind)
  }
}

private func desktopActs(_ raw: Any?) -> [DesktopAct]? {
  switch raw {
  case nil: return nil
  case let list as [Any]: return list.map(desktopAct)
  default: return [.malformed("acts that are not a list")]
  }
}

// The daemon's verdict: one JSON object, `{"ok":true,…}` when the click landed
// or `{"ok":false,"error":…,"code":…}` saying why it did not, with the acts it
// handed back beside either. Read once, so the acts and the outcome come from
// the same frame. Nil for a body that is neither.
func verdictOf(_ body: Data) -> Verdict? {
  guard let said = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
    let ok = said["ok"] as? Bool
  else { return nil }
  let acts = desktopActs(said[DESKTOP_ACTS_KEY])
  if ok { return Verdict(said: .delivered, acts: acts) }
  let why = said["error"] as? String ?? "the daemon gave no reason"
  // A refusal of the click is a bad request; any other failure is the daemon's
  // own, which lost the click.
  return Verdict(said: said["code"] as? String == "BAD_REQUEST" ? .refused(why) : .failed(why), acts: acts)
}

struct ActRefusal: Error, Equatable {
  let why: String
  init(_ why: String) { self.why = why }
}

// The editor link that opens `path` on `host`, or why it cannot be made.
func remoteEditorURL(host: HostAlias?, path: String) -> Result<URL, ActRefusal> {
  guard let host = host else {
    return .failure(
      ActRefusal(
        "the ssh forward for this bar names no host, so the editor cannot be pointed at it: run `cc-candybar ssh-config ALIAS` on the remote, replace its stanza in ~/.ssh/config, and reconnect"
      ))
  }
  guard path.hasPrefix("/") else {
    return .failure(ActRefusal("\(path) is not an absolute path on \(host.word)"))
  }
  guard let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
    return .failure(ActRefusal("\(path) cannot be spelled in a link to the editor"))
  }
  var parts = URLComponents()
  parts.scheme = REMOTE_EDITOR_SCHEME
  parts.host = REMOTE_EDITOR_AUTHORITY
  parts.percentEncodedPath = REMOTE_EDITOR_PATH_PREFIX + host.word + encoded
  guard let url = parts.url else { return .failure(ActRefusal("no editor link for \(path)")) }
  return .success(url)
}

// What this machine does for one act, decided before anything is done.
enum Step: Equatable {
  case copy(String)
  case open(URL)
  // Told to the person; nothing was done for this act.
  case cannot(String)
}

func plan(_ acts: [DesktopAct], host: HostAlias?) -> [Step] {
  acts.map { act in
    switch act {
    case .copy(let text): return .copy(text)
    case .open(let target):
      switch remoteEditorURL(host: host, path: target) {
      case .success(let url): return .open(url)
      case .failure(let refusal): return .cannot(refusal.why)
      }
    case .unknown(let what):
      return .cannot("the daemon asked for \(what), which this app does not know: run `cc-candybar install` to update it")
    case .malformed(let what):
      return .cannot("the daemon sent \(what): this app and that daemon disagree about the wire, so update cc-candybar on both")
    }
  }
}

// What this machine does for a verdict on a click that did, or did not, ask for
// its acts. A daemon that was asked and sent no key acted on its own machine
// and said nothing of it, which is told, not read as a click with no acts.
func steps(for verdict: Verdict, asked: Bool, host: HostAlias?) -> [Step] {
  guard let acts = verdict.acts else {
    return asked && verdict.said == .delivered
      ? [
        .cannot(
          "the daemon did not hand back the click's acts, so any copy or open ran on its own machine, not this one: it is older than this app, so update cc-candybar there and restart its daemon"
        )
      ]
      : []
  }
  return plan(acts, host: host)
}
