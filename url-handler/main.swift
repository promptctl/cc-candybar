// The cc-candybar URL handler: a resident macOS background-only app that
// forwards every `cc-candybar://` link Launch Services hands it to the daemon,
// as one frame, and reads back the daemon's verdict on it. The daemon parses
// the link and opens its signature; this app reads only which daemon signed it.
// Background-only (the Info.plist install writes) is what
// keeps a click from taking the terminal's keyboard focus: Launch Services
// never activates such an app.
//
// [LAW:one-source-of-truth] The app knows a few wire facts, all mirrored from
// src/daemon/foundations/protocol.ts, src/daemon/paths.ts and
// src/click/link-signer.ts and pinned by scripts/check-protocol.mjs: the frame
// (a 4-byte big-endian length, then the JSON `{"kind":"url","urlV":2,"url":…}`),
// the socket path, derived from the uid because Launch Services starts the app
// with no shell's environment, and where a link names its signer and where an
// ssh forward puts that signer's socket. A handler goes stale through what it
// knows, and this one knows nothing a release changes: not a bundle path, not
// a node binary, not a verb.
//
// [LAW:carrying-cost] No thread, no retry. The socket is non-blocking: a
// connect either completes at once (a unix socket with room in its backlog
// needs no round trip) or fails. The two waits are bounded, so a daemon that
// reads nothing cannot hold this app's main thread, which is the thread Launch
// Services delivers the next click on: one for a frame longer than the socket
// buffer, which lands only as the daemon reads it (WRITE_WAIT_MS), and one for
// the verdict (VERDICT_WAIT_MS), which the daemon writes as soon as it has
// read the frame, before the click runs.
//
// [LAW:no-silent-failure] The app sees three failures: a frame that could not
// be written, a frame written that got no verdict it could read (the click may
// still land, so it is told as unconfirmed, never as lost), and a link the
// daemon refused (one the bar never drew, or one changed since). Each is written to the unified log under the
// app's subsystem (`log stream --predicate 'subsystem ==
// "com.cccandybar.url-handler"'`) and told to the user as a macOS user
// notification carrying what was observed or the daemon's reason, never a
// diagnosis. A click whose verb fails is not one of them: the bar holds that
// failure. A lost click is lost by design: the app never starts a
// daemon, because that would need the paths that age, and a launcher the
// daemon left beside its socket would make this app a second enforcer
// [LAW:single-enforcer] of that directory's trust check and of the daemon's
// spawn-storm protections.
//
// The binary runs only inside its .app bundle: the notification center aborts
// the process at launch outside one, and no click can reach a bare binary
// anyway, because Launch Services delivers URLs to bundles.

import AppKit
import UserNotifications
import os

// Mirrored: src/daemon/foundations/protocol.ts FRAME_HEADER_BYTES, URL_FRAME_KIND and
// URL_FRAME_VERSION.
let FRAME_HEADER_BYTES = 4
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 2

// How long a write waits for the daemon to make room in the socket buffer.
// A daemon that is up reads a frame as soon as its loop turns; a bound this
// long is only ever reached by one that is wedged.
let WRITE_WAIT_MS: Int32 = 1000

// How long the app waits for the daemon's verdict on the link it wrote.
let VERDICT_WAIT_MS: Int32 = 1000

// The longest verdict the app reads: a reason, never a frame of the bar.
let VERDICT_MAX_BYTES = 65536

// Mirrored: src/daemon/paths.ts defaultSocketPath.
func socketPath() -> String {
  let uid = getuid()
  return "/tmp/cc-candybar-\(uid)/socket"
}

// Mirrored: src/daemon/paths.ts REMOTE_SOCKET_DIR_UNDER_HOME and
// REMOTE_SOCKET_SUFFIX, and src/click/link-signer.ts LINK_KEY_ID_CHARS,
// LINK_KEY_ID_ALPHABET, LINK_MAC_MARK and LINK_PROOF_SEPARATOR.
let REMOTE_SOCKET_DIR_UNDER_HOME = ".cc-candybar/remote"
let REMOTE_SOCKET_SUFFIX = ".sock"
let LINK_KEY_ID_CHARS = 8
let LINK_KEY_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
let LINK_MAC_MARK: Character = "#"
let LINK_PROOF_SEPARATOR: Character = "/"

let log = Logger(subsystem: "com.cccandybar.url-handler", category: "forward")

enum Forward {
  case delivered
  // The daemon refused the link, for the reason it gave.
  case refused(String)
  // The frame was written, and no verdict on it could be read.
  case unconfirmed(String)
  case failed(String)
}

func frame(_ url: String) -> Data {
  let body = try! JSONSerialization.data(
    withJSONObject: ["kind": URL_FRAME_KIND, "urlV": URL_FRAME_VERSION, "url": url],
    options: [])
  var header = UInt32(body.count).bigEndian
  var data = Data(bytes: &header, count: FRAME_HEADER_BYTES)
  data.append(body)
  return data
}

func errnoText(_ what: String) -> String {
  "\(what): \(String(cString: strerror(errno))) (errno \(errno))"
}

// One frame to the daemon's socket, non-blocking throughout.
func forward(_ url: String, to path: String) -> Forward {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  if fd < 0 { return .failed(errnoText("socket")) }
  defer { close(fd) }
  if fcntl(fd, F_SETFL, O_NONBLOCK) < 0 { return .failed(errnoText("fcntl")) }
  // A daemon that ends the socket mid-write (it exited, or refused the frame)
  // must be an EPIPE this function reports, never a SIGPIPE that ends the app
  // with nothing logged. [LAW:no-silent-failure]
  var one: Int32 = 1
  if setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size)) < 0 {
    return .failed(errnoText("setsockopt SO_NOSIGPIPE"))
  }

  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let capacity = MemoryLayout.size(ofValue: addr.sun_path)
  let pathBytes = Array(path.utf8CString)
  if pathBytes.count > capacity {
    return .failed("socket path longer than sun_path: \(path)")
  }
  withUnsafeMutablePointer(to: &addr.sun_path) { sunPath in
    sunPath.withMemoryRebound(to: CChar.self, capacity: capacity) { buffer in
      for (i, byte) in pathBytes.enumerated() { buffer[i] = byte }
    }
  }

  let connected = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  if connected < 0 { return .failed(errnoText("connect \(path)")) }

  let bytes = frame(url)
  let written: String? = bytes.withUnsafeBytes { buffer in
    var sent = 0
    while sent < bytes.count {
      let n = write(fd, buffer.baseAddress! + sent, bytes.count - sent)
      if n >= 0 {
        sent += n
        continue
      }
      if errno != EAGAIN { return errnoText("write") }
      // The socket buffer is full: a frame longer than it (a long link) lands
      // only as the daemon reads. Wait for room, bounded, and no longer.
      var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      let polled = poll(&ready, 1, WRITE_WAIT_MS)
      if polled < 0 { return errnoText("poll") }
      if polled == 0 {
        return "the daemon read nothing for \(WRITE_WAIT_MS)ms: \(sent) of \(bytes.count) bytes sent"
      }
    }
    return nil
  }
  if let why = written { return .failed(why) }
  return verdict(fd)
}

// A bar drawn by a daemon on another machine (the terminal is an ssh session)
// is signed by that daemon, and the click opens here. Only the daemon that
// signed a link opens it, and a link names its signer: the first field of its
// proof, `#<key id>/…`. The user's ssh forwards that daemon's socket to
// `<key id>.sock` in REMOTE_SOCKET_DIR_UNDER_HOME (`cc-candybar ssh-config` on
// that machine prints the lines), so the link goes to the one daemon it names:
// no host name, no route and no key is learned, nothing is tried in turn, and
// no daemon sees a link that is not its own. A link that names no forward on
// this Mac, its own or one whose ssh connection is not set up, goes to this
// Mac's daemon, which says which daemon signed it. [LAW:single-enforcer]
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

// Where a link goes: this Mac's own daemon, or the forward a link's id names.
enum Route {
  case own(socket: String)
  case forward(id: String, socket: String)

  var socket: String {
    switch self {
    case .own(let socket), .forward(_, let socket): return socket
    }
  }
}

func route(of link: String) -> Route {
  guard let id = signerId(of: link) else { return .own(socket: socketPath()) }
  // NSHomeDirectory, not $HOME: it is the account's home, which is what ssh's
  // `%d` spells in the stanza.
  let forwarded =
    NSHomeDirectory() + "/" + REMOTE_SOCKET_DIR_UNDER_HOME + "/" + id + REMOTE_SOCKET_SUFFIX
  return FileManager.default.fileExists(atPath: forwarded)
    ? .forward(id: id, socket: forwarded) : .own(socket: socketPath())
}

// A forward file can outlive the ssh connection that made it (ssh killed), and
// a daemon on the far end can be gone behind a live one, so a forward a link
// names that does not take the link says whose it is and what to look at,
// before the cause. [LAW:no-silent-failure]
func deliver(_ url: String, via route: Route) -> Forward {
  let sent = forward(url, to: route.socket)
  guard case .forward(let id, _) = route, case .failed(let why) = sent else { return sent }
  return .failed(
    "the ssh forward for key \(id) did not take the link; is the ssh connection to the machine that drew it open? \(why)"
  )
}

// Exactly `count` bytes from the socket by `deadline` (a monotonic ms count),
// or what stopped them.
func readExactly(_ fd: Int32, _ count: Int, by deadline: UInt64) -> Result<Data, ForwardError> {
  var data = Data(count: count)
  var got = 0
  while got < count {
    let n = data.withUnsafeMutableBytes { read(fd, $0.baseAddress! + got, count - got) }
    if n > 0 {
      got += n
      continue
    }
    if n == 0 { return .failure(ForwardError("the daemon hung up before its verdict")) }
    if errno != EAGAIN { return .failure(ForwardError(errnoText("read"))) }
    let left = Int64(deadline) - Int64(monotonicMs())
    if left <= 0 {
      return .failure(ForwardError("the daemon sent no verdict within \(VERDICT_WAIT_MS)ms"))
    }
    var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if poll(&ready, 1, Int32(left)) < 0 { return .failure(ForwardError(errnoText("poll"))) }
  }
  return .success(data)
}

struct ForwardError: Error {
  let why: String
  init(_ why: String) { self.why = why }
}

func monotonicMs() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000 }

// The daemon's verdict on the link: one frame, `{"ok":true,…}` when its
// signature opened, or `{"ok":false,"error":…}` saying why it did not.
func verdict(_ fd: Int32) -> Forward {
  let deadline = monotonicMs() + UInt64(VERDICT_WAIT_MS)
  let header: Data
  switch readExactly(fd, FRAME_HEADER_BYTES, by: deadline) {
  case .success(let d): header = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  let length = header.reduce(0) { ($0 << 8) | Int($1) }
  if length > VERDICT_MAX_BYTES {
    return .unconfirmed("the daemon's verdict is \(length) bytes, past \(VERDICT_MAX_BYTES)")
  }
  let body: Data
  switch readExactly(fd, length, by: deadline) {
  case .success(let d): body = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  guard let said = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
    let ok = said["ok"] as? Bool
  else { return .unconfirmed("the daemon's verdict is not one this app reads") }
  if ok { return .delivered }
  let why = said["error"] as? String ?? "the daemon gave no reason"
  // A refusal of the link is a bad request; any other failure is the daemon's
  // own (it was closing), which lost the click.
  return said["code"] as? String == "BAD_REQUEST" ? .refused(why) : .failed(why)
}

// Tells the user a click was lost or refused, in a form that needs no bar to
// land on. The body is the observed failure as the forward reported it, or the
// daemon's reason; the user reads it as the fact it is. Authorization is asked for on every lost click: the request
// completes without a prompt once the user has answered, so the app keeps no
// state about it, and a user who never loses a click never sees the prompt.
// The banner shows only because this app is never frontmost: macOS hides a
// frontmost app's notifications unless its delegate asks for them, and a
// background-only app is never activated, so no delegate is needed. An app
// that Launch Services can activate again loses its banner silently.
// One fixed identifier per condition: a run of lost clicks is one notice
// carrying the latest observation, not a stack of copies.
// [LAW:no-silent-failure] A post the center refuses (notifications denied for
// the app, or an OS error) is logged under the subsystem; the user who denied
// them chose not to be told this way, and there is no second channel.
let lostClickNotice = "lost-click"
let refusedClickNotice = "refused-click"

func notify(_ title: String, _ why: String, _ identifier: String) {
  let center = UNUserNotificationCenter.current()
  center.requestAuthorization(options: [.alert]) { granted, error in
    if let error = error {
      log.error("notification authorization failed: \(error.localizedDescription, privacy: .public)")
      return
    }
    if !granted {
      // A user's choice, not this app's failure: notice, not error.
      log.notice("notification not shown: the user has not allowed notifications for this app")
      return
    }
    let content = UNMutableNotificationContent()
    // The product's name is the banner's header, from the bundle's display name.
    content.title = title
    content.body = why
    let request = UNNotificationRequest(
      identifier: identifier, content: content, trigger: nil)
    center.add(request) { error in
      if let error = error {
        log.error("notification not shown: \(error.localizedDescription, privacy: .public)")
      }
    }
  }
}

final class Handler: NSObject, NSApplicationDelegate {
  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
      let link = url.absoluteString
      let routed = route(of: link)
      let socket = routed.socket
      switch deliver(link, via: routed) {
      // Notice, not info: the unified log persists notice and above, so
      // `log show` can answer "did the click reach the socket" after the fact.
      // The link itself is private: a copy link carries the text being copied,
      // and the unified log is readable by every admin on the machine. The
      // daemon's own click event records the link, in the user's own log.
      // [LAW:nothing-unseen]
      case .delivered:
        log.notice("forwarded \(link, privacy: .private) to \(socket, privacy: .public)")
      case .refused(let why):
        log.error("refused \(link, privacy: .private) by \(socket, privacy: .public): \(why, privacy: .public)")
        notify("Click refused", why, refusedClickNotice)
      case .unconfirmed(let why):
        log.error("unconfirmed \(link, privacy: .private) at \(socket, privacy: .public): \(why, privacy: .public)")
        notify("Click unconfirmed", why, lostClickNotice)
      case .failed(let why):
        log.error("lost \(link, privacy: .private) to \(socket, privacy: .public): \(why, privacy: .public)")
        notify("Click not delivered", why, lostClickNotice)
      }
    }
  }
}

let app = NSApplication.shared
let handler = Handler()
app.delegate = handler
app.run()
