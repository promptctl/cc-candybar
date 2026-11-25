// What the cc-candybar URL handler knows of the wire and of the names an ssh
// forward carries: pure reads of bytes and strings, with no socket, no AppKit
// and no clock, so `url-handler/check.sh` runs them under test. main.swift
// does the socket, the notifications and the pasteboard.
//
// [LAW:one-source-of-truth] Every fact here is mirrored from
// src/daemon/foundations/protocol.ts, src/daemon/paths.ts, src/ssh-cli.ts and
// src/click/link-signer.ts, and pinned by scripts/check-protocol.mjs. A handler
// goes stale through what it knows, and this one knows nothing a release
// changes: not a bundle path, not a node binary, not a verb.

import Foundation

// Mirrored: src/daemon/foundations/protocol.ts FRAME_HEADER_BYTES,
// MAX_FRAME_BYTES, URL_FRAME_KIND, URL_FRAME_VERSION and ACTS_ON_DESKTOP.
let FRAME_HEADER_BYTES = 4
let MAX_FRAME_BYTES = 16 * 1024 * 1024
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 2
let ACTS_ON_DESKTOP = "desktop"

// Mirrored: src/daemon/paths.ts REMOTE_SOCKET_DIR_UNDER_HOME,
// REMOTE_SOCKET_SUFFIX and REMOTE_SOCKET_HOST_SEPARATOR,
// src/click/link-signer.ts LINK_KEY_ID_CHARS, LINK_KEY_ID_ALPHABET,
// LINK_MAC_MARK and LINK_PROOF_SEPARATOR, and src/ssh-cli.ts HOST_ALIAS.
let REMOTE_SOCKET_DIR_UNDER_HOME = ".cc-candybar/remote"
let REMOTE_SOCKET_SUFFIX = ".sock"
let REMOTE_SOCKET_HOST_SEPARATOR: Character = "."
let LINK_KEY_ID_CHARS = 8
let LINK_KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
let LINK_MAC_MARK: Character = "#"
let LINK_PROOF_SEPARATOR: Character = "/"
let HOST_ALIAS_PATTERN = "^[A-Za-z0-9_][A-Za-z0-9._-]*$"

// Mirrored: src/daemon/paths.ts defaultSocketPath, derived from the uid because
// Launch Services starts the app with no shell's environment.
func socketPath(uid: uid_t) -> String {
  "/tmp/cc-candybar-\(uid)/socket"
}

// Where a click's copy and open act: on the machine the daemon is on, which is
// this one when the daemon is this Mac's own, or on this machine when the
// daemon is another's (the bar was drawn over ssh), whose daemon then hands
// them back in its verdict.
enum Place {
  case daemon
  case desktop
}

// What a click asks of this machine, which only a daemon on another machine
// asks (the daemon acts on its own machine otherwise): the text to copy, or a
// path on that other machine to open.
enum DesktopAct: Equatable {
  case copy(String)
  case open(String)
}

enum Forward: Equatable {
  // The daemon opened the link, and asks these acts of this machine.
  case delivered([DesktopAct])
  // The click failed in the daemon, after asking these acts of this machine,
  // which a click on this machine's own bar would have run.
  case clickFailed(String, [DesktopAct])
  // The daemon refused the link or its arguments, for the reason it gave,
  // after asking these acts of this machine.
  case refused(String, [DesktopAct])
  // The frame was written, and no verdict on it could be read.
  case unconfirmed(String)
  // The click landed, and what it asks of this machine could not be read.
  case unread(String)
  // Nothing was written: no daemon listens at the socket, as one a dead ssh
  // left behind.
  case unreachable(String)
  case failed(String)
}

struct ForwardError: Error {
  let why: String
  init(_ why: String) { self.why = why }
}

// One frame: a 4-byte big-endian length, then the JSON the daemon reads.
// `place` is `.desktop` for a link sent down an ssh forward, whose copy and
// open this app carries out itself.
func frame(_ url: String, place: Place) -> Data {
  var object: [String: Any] = ["kind": URL_FRAME_KIND, "urlV": URL_FRAME_VERSION, "url": url]
  if place == .desktop { object["actsOn"] = ACTS_ON_DESKTOP }
  let body = try! JSONSerialization.data(withJSONObject: object, options: [])
  var header = UInt32(body.count).bigEndian
  var data = Data(bytes: &header, count: FRAME_HEADER_BYTES)
  data.append(body)
  return data
}

// A bar drawn by a daemon on another machine (the terminal is an ssh session)
// is signed by that daemon, and the click opens here. Only the daemon that
// signed a link opens it, and a link names its signer: the first field of its
// proof, `#<key id>/…`. The user's ssh forwards that daemon's socket to
// `<key id>.<host>.sock` in REMOTE_SOCKET_DIR_UNDER_HOME (`cc-candybar
// ssh-config` on that machine prints the lines), so the link goes to the one
// daemon it names: no route and no key is learned, no daemon sees a link that
// is not its own, and the only files tried in turn are those the one id names
// (the same daemon under another host name, one of them a dead ssh's). A link
// that names no forward on this Mac, its own or one whose ssh connection is not
// set up, goes to this Mac's daemon, which says which daemon signed it.
// [LAW:single-enforcer]
// The id a link names, or nil for a link that names none (a proof that does not
// begin with one, as links drawn before they named a signer do not). The link
// comes from any web page, and the id becomes part of a path, so it is the
// spelling the signer writes and nothing else.
func signerId(of link: String) -> String? {
  guard let mark = link.lastIndex(of: LINK_MAC_MARK) else { return nil }
  let proof = link[link.index(after: mark)...]
  guard let slash = proof.firstIndex(of: LINK_PROOF_SEPARATOR) else { return nil }
  let id = proof[..<slash]
  guard id.utf8.count == LINK_KEY_ID_CHARS, id.allSatisfy({ LINK_KEY_ID_ALPHABET.contains($0) })
  else { return nil }
  return String(id)
}

// [LAW:parse-dont-validate] One word of ssh's config naming one host, as the
// user typed it after `ssh`: what a stanza's `Host` line holds and `%n` spells.
// It rides in a file name read off a directory and then into the editor's link,
// so it is the spelling `cc-candybar ssh-config` accepts and nothing else.
struct HostAlias: Equatable {
  let name: String
  init?(_ word: String) {
    guard word.range(of: HOST_ALIAS_PATTERN, options: .regularExpression) != nil else {
      return nil
    }
    name = word
  }
}

// What a forward's file name says of the host the user's ssh reaches that
// machine by, which the editor needs to open a file there.
enum ForwardHost: Equatable {
  case named(HostAlias)
  // A forward set up before its name carried the host.
  case unnamed
  // A name whose host is not one `cc-candybar ssh-config` writes.
  case malformed(String)
}

// A forward the user's ssh made: the socket, and the host its name carries.
struct Forwarded: Equatable {
  let socket: String
  let host: ForwardHost
}

// The forwards the id names among a directory's file names: `<id>.<host>.sock`
// (or `<id>.sock`, from a stanza that named no host), in name order. More than
// one file for an id is the same daemon under two names.
func forwardsIn(names: [String], id: String, dir: String) -> [Forwarded] {
  let head = id + String(REMOTE_SOCKET_HOST_SEPARATOR)
  var found: [Forwarded] = []
  for name in names.sorted() where name.hasSuffix(REMOTE_SOCKET_SUFFIX) {
    let socket = dir + "/" + name
    if name == id + REMOTE_SOCKET_SUFFIX {
      found.append(Forwarded(socket: socket, host: .unnamed))
      continue
    }
    guard name.hasPrefix(head), name.count > head.count + REMOTE_SOCKET_SUFFIX.count else {
      continue
    }
    let word = String(name.dropFirst(head.count).dropLast(REMOTE_SOCKET_SUFFIX.count))
    found.append(
      Forwarded(socket: socket, host: HostAlias(word).map(ForwardHost.named) ?? .malformed(word)))
  }
  return found
}

// Where a link goes: this Mac's own daemon, or the forwards a link's id names.
enum Route {
  case own(socket: String)
  case forward(id: String, via: [Forwarded])
  // The directory of forwards could not be read, which is not "no forward".
  case unreadable(String)

  // [LAW:one-source-of-truth] The route owns where the click's acts go: a
  // daemon on another machine acts on that machine, so a frame sent down a
  // forward asks for the acts to be handed back, and any other does not.
  var place: Place {
    switch self {
    case .forward: return .desktop
    case .own, .unreadable: return .daemon
    }
  }

  // The clicks that share a queue: those to one daemon, which reach it in the
  // order they were made.
  var queueKey: String {
    switch self {
    case .own(let socket): return socket
    case .forward(let id, _): return id
    case .unreadable: return "unreadable"
    }
  }
}

// One act a verdict asks of this machine: `{"kind":"copy","text":…}` or
// `{"kind":"open","target":…}`. [LAW:parse-dont-validate] An act this app cannot
// read is a failure naming it, never one dropped: it is a daemon newer than the
// app, or a bug.
func desktopAct(_ said: [String: Any]) -> Result<DesktopAct, ForwardError> {
  switch said["kind"] as? String {
  case "copy":
    guard let text = said["text"] as? String else {
      return .failure(ForwardError("a copy act with no text: \(said)"))
    }
    return .success(.copy(text))
  case "open":
    guard let target = said["target"] as? String else {
      return .failure(ForwardError("an open act with no target: \(said)"))
    }
    return .success(.open(target))
  default:
    return .failure(
      ForwardError("an act this app does not know: \(said); is the app older than the daemon?"))
  }
}

// The acts of the verdict of a frame that asked for them: `"desktopActs":[…]`,
// in the order asked. A daemon that does not hand acts back says nothing of
// them, which is not the same as a click that asked none (an empty list).
func desktopActs(in said: [String: Any]) -> Result<[DesktopAct], ForwardError> {
  guard let field = said["desktopActs"] else {
    return .failure(
      ForwardError(
        "the daemon that drew this bar does not hand its copy and open to this app: it is older than the app, and the click acted there; update cc-candybar on that machine"
      ))
  }
  guard let asked = field as? [[String: Any]] else {
    return .failure(ForwardError("the daemon's desktopActs is not a list of acts: \(field)"))
  }
  var acts: [DesktopAct] = []
  for entry in asked {
    switch desktopAct(entry) {
    case .success(let act): acts.append(act)
    case .failure(let e): return .failure(e)
    }
  }
  return .success(acts)
}

// The daemon's verdict on the link: `{"ok":true,…}` when its signature opened,
// or `{"ok":false,"error":…}` saying why it did not, or why the click failed
// after it asked acts of this machine. A frame sent to ask for the acts is
// answered with them, so one that comes back without them is said.
func verdictOf(_ body: Data, place: Place) -> Forward {
  guard let said = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
    let ok = said["ok"] as? Bool
  else { return .unconfirmed("the daemon's verdict is not one this app reads") }
  var why = said["error"] as? String ?? "the daemon gave no reason"
  if ok {
    guard place == .desktop else { return .delivered([]) }
    switch desktopActs(in: said) {
    case .success(let acts): return .delivered(acts)
    case .failure(let e): return .unread(e.why)
    }
  }
  // A failed click hands back what it asked before it failed, when its daemon
  // hands acts back at all; one that does not has nothing to lose here.
  var acts: [DesktopAct] = []
  if place == .desktop, said["desktopActs"] != nil {
    switch desktopActs(in: said) {
    case .success(let asked): acts = asked
    case .failure(let e): why += "; its copy and open acts were not read: \(e.why)"
    }
  }
  // What the failure is comes from its code, whatever the acts: a refusal of
  // the link or its arguments is a bad request, the person's to act on; any
  // other failure is the daemon's own, which lost the click.
  return said["code"] as? String == "BAD_REQUEST" ? .refused(why, acts) : .clickFailed(why, acts)
}

// The editor's link to a path on another machine, which the editor reaches by
// the `Host` its ssh config names: `vscode://vscode-remote/ssh-remote+<host><path>`.
func remoteEditorURL(host: HostAlias, path: String) -> URL? {
  var parts = URLComponents()
  parts.scheme = "vscode"
  parts.host = "vscode-remote"
  parts.path = "/ssh-remote+" + host.name + path
  return parts.url
}
