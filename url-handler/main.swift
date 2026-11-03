// The cc-candybar URL handler: a resident macOS agent app that forwards every
// `cc-candybar://` link Launch Services hands it to the daemon, as one frame,
// and does nothing else. The daemon parses the link; this app never reads it.
//
// [LAW:one-source-of-truth] The app knows two wire facts, both mirrored from
// src/daemon/protocol.ts and src/daemon/paths.ts and pinned by
// scripts/check-protocol.mjs: the frame (a 4-byte big-endian length, then the
// JSON `{"kind":"url","urlV":1,"url":…}`) and the socket path, derived from
// the uid because Launch Services starts the app with no shell's environment.
// A handler goes stale through what it knows, and this one knows nothing a
// release changes: not a bundle path, not a node binary, not a verb.
//
// [LAW:carrying-cost] No thread, no retry. The socket is non-blocking: a
// connect either completes at once (a unix socket with room in its backlog
// needs no round trip) or fails. The one wait is for a frame longer than the
// socket buffer, which lands only as the daemon reads it, and it is bounded
// (WRITE_WAIT_MS) so a daemon that reads nothing cannot hold this app's main
// thread, which is the thread Launch Services delivers the next click on.
//
// [LAW:no-silent-failure] A frame that could not be written is the one failure
// this app can see, and it is written to the unified log under the app's
// subsystem (`log stream --predicate 'subsystem == "com.cccandybar.url-handler"'`).
// The click is lost by design: the app never starts a daemon, because that
// would need the paths that age. Telling the user is the next ticket.

import AppKit
import os

// Mirrored: src/daemon/protocol.ts FRAME_HEADER_BYTES, URL_FRAME_KIND and
// URL_FRAME_VERSION.
let FRAME_HEADER_BYTES = 4
let URL_FRAME_KIND = "url"
let URL_FRAME_VERSION = 1

// How long a write waits for the daemon to make room in the socket buffer.
// A daemon that is up reads a frame as soon as its loop turns; a bound this
// long is only ever reached by one that is wedged.
let WRITE_WAIT_MS: Int32 = 1000

// Mirrored: src/daemon/paths.ts defaultSocketPath.
func socketPath() -> String {
  let uid = getuid()
  return "/tmp/cc-candybar-\(uid)/socket"
}

let log = Logger(subsystem: "com.cccandybar.url-handler", category: "forward")

enum Forward {
  case delivered
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
  return bytes.withUnsafeBytes { buffer in
    var sent = 0
    while sent < bytes.count {
      let n = write(fd, buffer.baseAddress! + sent, bytes.count - sent)
      if n >= 0 {
        sent += n
        continue
      }
      if errno != EAGAIN { return .failed(errnoText("write")) }
      // The socket buffer is full: a frame longer than it (a long link) lands
      // only as the daemon reads. Wait for room, bounded, and no longer.
      var ready = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      let polled = poll(&ready, 1, WRITE_WAIT_MS)
      if polled < 0 { return .failed(errnoText("poll")) }
      if polled == 0 {
        return .failed("the daemon read nothing for \(WRITE_WAIT_MS)ms: \(sent) of \(bytes.count) bytes sent")
      }
    }
    return .delivered
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
      case .failed(let why):
        log.error("lost \(link, privacy: .private): \(why, privacy: .public)")
      }
    }
  }
}

let app = NSApplication.shared
let handler = Handler()
app.delegate = handler
app.run()
