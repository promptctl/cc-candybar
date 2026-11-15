// The cc-candybar URL handler: a resident macOS background-only app that
// forwards every `cc-candybar://` link Launch Services hands it to the daemon,
// as one frame, and tells the user when the click fails. The daemon parses and
// verifies the link; this app never reads it. Background-only (the Info.plist
// install writes) is what keeps a click from taking the terminal's keyboard
// focus: Launch Services never activates such an app.
//
// [LAW:one-source-of-truth] The app knows three wire facts, mirrored from
// src/daemon/foundations/protocol.ts and src/daemon/paths.ts and pinned by
// scripts/check-protocol.mjs: the frame (a 4-byte big-endian length, then the
// JSON `{"kind":"url","urlV":2,"url":…}`), the answer the daemon writes back
// in the same framing (`ok`, and on a failure its `error`), and the socket
// path, derived from the uid because Launch Services starts the app with no
// shell's environment.
// A handler goes stale through what it knows, and this one knows nothing a
// release changes: not a bundle path, not a node binary, not a verb.
//
// [LAW:carrying-cost] No thread, no retry. The socket is non-blocking: a
// connect either completes at once (a unix socket with room in its backlog
// needs no round trip) or fails. Its waits, for room to write a frame longer
// than the socket buffer and for the answer, are bounded (WRITE_WAIT_MS,
// ANSWER_WAIT_MS) so a daemon that reads nothing cannot hold this app's main
// thread, which is the thread Launch Services delivers the next click on.
//
// [LAW:no-silent-failure] Two failures are this app's to tell: a click that
// was not delivered (a frame that could not be written, or no answer read),
// and one the daemon answered as failed (a link no bar drew, no renderer
// there to take it within the daemon's deadline, a verb's own failure), which
// may have no bar to land on. Each is written to the unified log under the
// app's subsystem
// (`log stream --predicate 'subsystem == "com.cccandybar.url-handler"'`) and
// told to the user as a macOS user notification carrying what was observed or
// the daemon's reason, never a diagnosis. The click is lost by design: the app
// never starts a daemon, because that would need the paths that age, and a
// launcher the
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

// Mirrored: src/daemon/foundations/protocol.ts FRAME_HEADER_BYTES, URL_FRAME_KIND,
// URL_FRAME_VERSION.
let FRAME_HEADER_BYTES = 4
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 2

// How long a write waits for the daemon to make room in the socket buffer.
// A daemon that is up reads a frame as soon as its loop turns; a bound this
// long is only ever reached by one that is wedged.
let WRITE_WAIT_MS: Int32 = 1000

// How long the app waits for the daemon's answer, which comes when the
// click's turn has run: a click that has not landed by then did not land, or
// lands later than its user can tell, and is told as lost.
let ANSWER_WAIT_MS: Int32 = 1000

// Mirrored: src/daemon/paths.ts defaultSocketPath.
func socketPath() -> String {
  let uid = getuid()
  return "/tmp/cc-candybar-\(uid)/socket"
}

let log = Logger(subsystem: "com.cccandybar.url-handler", category: "forward")

enum Forward {
  case delivered
  // The daemon answered that the click failed, for the reason it gave.
  case refused(String)
  // Not written, or no answer was read.
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
func forward(_ url: String) -> Forward {
  let path = socketPath()
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
  return answer(fd)
}

// The daemon's answer, one frame: its length, then its JSON. A failure
// carries the daemon's reason.
func answer(_ fd: Int32) -> Forward {
  var data = Data()
  var need = FRAME_HEADER_BYTES
  var header = true
  let deadline = DispatchTime.now().uptimeNanoseconds + UInt64(ANSWER_WAIT_MS) * 1_000_000
  var chunk = [UInt8](repeating: 0, count: 4096)
  while data.count < need {
    let now = DispatchTime.now().uptimeNanoseconds
    if now >= deadline { return .failed("no answer within \(ANSWER_WAIT_MS)ms") }
    var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    let polled = poll(&ready, 1, Int32((deadline - now) / 1_000_000) + 1)
    if polled < 0 { return .failed(errnoText("poll")) }
    if polled == 0 { continue }
    let n = read(fd, &chunk, min(chunk.count, need - data.count))
    if n < 0 {
      if errno == EAGAIN { continue }
      return .failed(errnoText("read"))
    }
    if n == 0 { return .failed("the daemon closed the socket before it answered") }
    data.append(contentsOf: chunk[0..<n])
    if header && data.count == FRAME_HEADER_BYTES {
      need = FRAME_HEADER_BYTES + Int(data.reduce(UInt32(0)) { $0 << 8 | UInt32($1) })
      header = false
    }
  }
  let body = data.subdata(in: FRAME_HEADER_BYTES..<data.count)
  guard let reply = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
    let ok = reply["ok"] as? Bool
  else { return .failed("an answer this app cannot read") }
  if ok { return .delivered }
  return .refused(reply["error"] as? String ?? "the daemon gave no reason")
}

// Tells the user a click was lost or refused, in a form that needs no bar. The
// body is the observed failure as the forward reported it, or the daemon's
// reason; the user reads it as the fact it is. Authorization is asked for on
// every lost click: the request completes without a prompt once the user has
// answered, so the app keeps no state about it, and a user who never loses a
// click never sees the prompt.
// The banner shows only because this app is never frontmost: macOS hides a
// frontmost app's notifications unless its delegate asks for them, and a
// background-only app is never activated, so no delegate is needed. An app
// that Launch Services can activate again loses its banner silently.
// One fixed identifier, because there is one condition, a click that did
// nothing: a run of them is one notice carrying the latest, not a stack of
// copies.
// [LAW:no-silent-failure] A post the center refuses (notifications denied for
// the app, or an OS error) is logged under the subsystem; the user who denied
// them chose not to be told this way, and there is no second channel.
let clickNotice = "click"

func notify(_ title: String, _ why: String) {
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
      identifier: clickNotice, content: content, trigger: nil)
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
      switch forward(link) {
      // Notice, not info: the unified log persists notice and above, so
      // `log show` can answer "did the click reach the socket" after the fact.
      // The link itself is private: a copy link carries the text being copied,
      // and the unified log is readable by every admin on the machine. The
      // daemon's own click event records the link, in the user's own log.
      // [LAW:nothing-unseen]
      case .delivered:
        log.notice("forwarded \(link, privacy: .private)")
      case .refused(let why):
        log.error("failed \(link, privacy: .private): \(why, privacy: .public)")
        notify("Click failed", why)
      case .failed(let why):
        log.error("lost \(link, privacy: .private): \(why, privacy: .public)")
        notify("Click not delivered", why)
      }
    }
  }
}

let app = NSApplication.shared
let handler = Handler()
app.delegate = handler
app.run()
