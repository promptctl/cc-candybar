// What the URL handler knows of the wire, as pure reads over bytes and names:
// no socket, no AppKit, no clock. main.swift does the I/O and carries out what
// these functions decide; url-handler/tests/main.swift states what they decide,
// and `check.sh` runs it, so the decisions are checked without a click.
//
// [LAW:one-source-of-truth] The constants are mirrored from
// src/daemon/foundations/protocol.ts, src/daemon/paths.ts and
// src/click/link-signer.ts, and pinned by scripts/check-protocol.mjs.
// [LAW:parse-dont-validate] Everything the daemon or the file system hands this
// app is read once, here, into a type that cannot hold what the app would have
// to guard against: a host alias, a forward's name, a verdict and its acts.

import Foundation

// Mirrored: protocol.ts FRAME_HEADER_BYTES, MAX_FRAME_BYTES, URL_FRAME_KIND,
// URL_FRAME_VERSION and ACTS_ON_DESKTOP.
let FRAME_HEADER_BYTES = 4
let MAX_FRAME_BYTES = 16 * 1024 * 1024
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 2
let ACTS_ON_DESKTOP = "desktop"

// Mirrored: protocol.ts ClickVerdict and DesktopAct, the verdict's key for the
// acts a click asked of this machine and the shape of each.
let DESKTOP_ACTS_KEY = "desktopActs"
let ACT_KIND_KEY = "kind"
let ACT_KIND_COPY = "copy"
let ACT_KIND_OPEN = "open"
let ACT_COPY_TEXT_KEY = "text"
let ACT_OPEN_TARGET_KEY = "target"

// Mirrored: paths.ts REMOTE_SOCKET_DIR_UNDER_HOME, REMOTE_SOCKET_SUFFIX,
// REMOTE_SOCKET_HOST_SEPARATOR, HOST_ALIAS_FIRST and HOST_ALIAS_REST, and
// link-signer.ts LINK_KEY_ID_CHARS, LINK_KEY_ID_ALPHABET, LINK_MAC_MARK and
// LINK_PROOF_SEPARATOR.
let REMOTE_SOCKET_DIR_UNDER_HOME = ".cc-candybar/remote"
let REMOTE_SOCKET_SUFFIX = ".sock"
let REMOTE_SOCKET_HOST_SEPARATOR = "."
let HOST_ALIAS_FIRST = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_"
let HOST_ALIAS_REST = HOST_ALIAS_FIRST + ".-"
let LINK_KEY_ID_CHARS = 8
let LINK_KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
let LINK_MAC_MARK: Character = "#"
let LINK_PROOF_SEPARATOR: Character = "/"

// The editor's link to a path on a machine ssh reaches: VS Code's remote
// authority names the host by the alias the user's ssh config knows it by.
let REMOTE_EDITOR_PREFIX = "vscode://vscode-remote/ssh-remote+"

// One frame: the header, then the body. `desktop` is a frame that asks for the
// click's copy and open acts to come back (see ACTS_ON_DESKTOP), which only a
// frame sent down an ssh forward does: a link drawn on this Mac acts on this
// Mac already.
func frame(_ url: String, actsOn desktop: Bool) -> Data {
  let said: [String: Any] = ["kind": URL_FRAME_KIND, "urlV": URL_FRAME_VERSION, "url": url]
  let fields = desktop ? said.merging(["actsOn": ACTS_ON_DESKTOP]) { first, _ in first } : said
  let body = try! JSONSerialization.data(withJSONObject: fields, options: [])
  var header = UInt32(body.count).bigEndian
  var data = Data(bytes: &header, count: FRAME_HEADER_BYTES)
  data.append(body)
  return data
}

// The length a frame header states.
func frameLength(_ header: Data) -> Int { header.reduce(0) { ($0 << 8) | Int($1) } }

// The key id a link names its signer by, or nil for a link that names none (a
// proof that does not begin with one, as links drawn before they named a
// signer do not). The link comes from any web page and the id becomes part of
// a path, so it is the spelling the signer writes and nothing else.
// [LAW:one-source-of-truth] The one parser of the id.
func keyId(of link: String) -> String? {
  guard let mark = link.lastIndex(of: LINK_MAC_MARK) else { return nil }
  let proof = link[link.index(after: mark)...]
  guard let slash = proof.firstIndex(of: LINK_PROOF_SEPARATOR) else { return nil }
  let id = proof[..<slash]
  guard id.utf8.count == LINK_KEY_ID_CHARS, id.allSatisfy({ LINK_KEY_ID_ALPHABET.contains($0) })
  else { return nil }
  return String(id)
}

// A host alias: one word of ssh's config naming one host, in a spelling a file
// name and an editor's link carry as they are. The first character is no `-`
// or `.`, so it is no option and no hidden file.
struct HostAlias: Equatable {
  let word: String

  init?(_ word: String) {
    guard let first = word.first, HOST_ALIAS_FIRST.contains(first),
      word.dropFirst().allSatisfy({ HOST_ALIAS_REST.contains($0) })
    else { return nil }
    self.word = word
  }
}

// What a forward's file name says of the machine behind it.
enum ForwardHost: Equatable {
  case alias(HostAlias)
  // The name carries no alias: a forward set up before names carried one.
  case unnamed
  // The name carries a word that is no alias; it is held to be told.
  case malformed(String)
}

// A forward's file name: `<key id>.sock` or `<key id>.<alias>.sock`.
struct ForwardName: Equatable {
  let keyId: String
  let host: ForwardHost

  init?(file: String) {
    guard file.hasSuffix(REMOTE_SOCKET_SUFFIX) else { return nil }
    let stem = String(file.dropLast(REMOTE_SOCKET_SUFFIX.count))
    let id = String(stem.prefix(LINK_KEY_ID_CHARS))
    guard id.count == LINK_KEY_ID_CHARS, id.allSatisfy({ LINK_KEY_ID_ALPHABET.contains($0) })
    else { return nil }
    let rest = stem.dropFirst(LINK_KEY_ID_CHARS)
    if rest.isEmpty {
      host = .unnamed
    } else if rest.hasPrefix(REMOTE_SOCKET_HOST_SEPARATOR) {
      let word = String(rest.dropFirst(REMOTE_SOCKET_HOST_SEPARATOR.count))
      host = HostAlias(word).map(ForwardHost.alias) ?? .malformed(word)
    } else {
      return nil
    }
    keyId = id
  }
}

struct ForwardEntry: Equatable {
  let file: String
  let name: ForwardName
  let modified: Date
}

// Which forward file takes a link: of those naming its key, the newest, because
// a Mac can hold forwards to one key from two aliases (one machine reached two
// ways, or an alias renamed) and the live connection made the latest file.
func newestForward(naming id: String, among entries: [ForwardEntry]) -> ForwardEntry? {
  entries.filter { $0.name.keyId == id }.max { $0.modified < $1.modified }
}

// The editor's link to `path` on the machine `host` names, or nil for a path
// that is no absolute path (the daemon's target is one, so another is the
// daemon's mistake to be told, not a link to guess at).
func remoteEditorURL(host: HostAlias, path: String) -> String? {
  guard path.hasPrefix("/"),
    let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
  else { return nil }
  return REMOTE_EDITOR_PREFIX + host.word + encoded
}

// One act a click asked of this machine, read from the verdict.
enum DesktopAct: Equatable {
  case copy(String)
  case open(String)
  // A kind this app does not do: told, not dropped, because the click asked.
  case unknown(String)
  // An act that is not one the wire spells: what is wrong with it.
  case malformed(String)
}

func desktopAct(of raw: Any) -> DesktopAct {
  guard let act = raw as? [String: Any], let kind = act[ACT_KIND_KEY] as? String else {
    return .malformed("an act with no kind")
  }
  switch kind {
  case ACT_KIND_COPY:
    guard let text = act[ACT_COPY_TEXT_KEY] as? String else {
      return .malformed("a copy with no \(ACT_COPY_TEXT_KEY)")
    }
    return .copy(text)
  case ACT_KIND_OPEN:
    guard let target = act[ACT_OPEN_TARGET_KEY] as? String else {
      return .malformed("an open with no \(ACT_OPEN_TARGET_KEY)")
    }
    return .open(target)
  default:
    return .unknown(kind)
  }
}

// What the daemon said of the link itself.
enum Said: Equatable {
  case accepted
  // The link was refused: one the bar never drew, or one changed since.
  case refused(String)
  // The daemon could not take the click at all (it was closing).
  case failed(String)
}

struct Verdict: Equatable {
  let said: Said
  // nil: the verdict has no acts key, which is what a daemon older than this
  // app says to a frame that asked for them. [] is a click that asked for none.
  let acts: [DesktopAct]?
}

// The verdict, or nil when the bytes are not one this app reads. The failure's
// kind comes from the daemon's code: a bad request is the link's, any other is
// the daemon's own.
func verdictOf(_ body: Data) -> Verdict? {
  guard let said = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
    let ok = said["ok"] as? Bool
  else { return nil }
  if !ok {
    let why = said["error"] as? String ?? "the daemon gave no reason"
    return Verdict(
      said: said["code"] as? String == "BAD_REQUEST" ? .refused(why) : .failed(why), acts: nil)
  }
  guard let raw = said[DESKTOP_ACTS_KEY] else { return Verdict(said: .accepted, acts: nil) }
  guard let list = raw as? [Any] else {
    return Verdict(
      said: .accepted, acts: [.malformed("\(DESKTOP_ACTS_KEY) is not a list")])
  }
  return Verdict(said: .accepted, acts: list.map(desktopAct))
}

// What this app does once the daemon has accepted the click: each act in the
// order the click asked, or the notice the user is owed in its place.
enum Step: Equatable {
  case copy(String)
  case open(String)
  case tell(String)
}

// [LAW:no-silent-failure] A click that asked for acts and got none it can carry
// out says so: a verdict with no acts key is a daemon older than this app, an
// open whose forward names no host cannot reach the files, and an act this app
// does not know or cannot read is told, never dropped.
func steps(for verdict: Verdict, asked: Bool, host: ForwardHost) -> [Step] {
  guard asked, verdict.said == .accepted else { return [] }
  guard let acts = verdict.acts else {
    return [
      .tell(
        "cc-candybar on the machine that drew this bar is older than this app, so the click did nothing here: update cc-candybar there and restart its daemon"
      )
    ]
  }
  return acts.map { act in
    switch act {
    case .copy(let text):
      return .copy(text)
    case .open(let target):
      switch host {
      case .alias(let alias):
        return remoteEditorURL(host: alias, path: target).map(Step.open)
          ?? .tell("the daemon asked to open \(target), which is not an absolute path")
      case .unnamed:
        return .tell(
          "cannot open \(target): this ssh forward names no host, so no editor can reach it; set the forward up again with `cc-candybar ssh-config ALIAS` on the machine that drew this bar"
        )
      case .malformed(let word):
        return .tell(
          "cannot open \(target): this ssh forward names its host \"\(word)\", which is no host alias this app can hand an editor"
        )
      }
    case .unknown(let kind):
      return .tell("the daemon asked for \"\(kind)\", which this app does not do")
    case .malformed(let why):
      return .tell("the daemon sent \(why)")
    }
  }
}
