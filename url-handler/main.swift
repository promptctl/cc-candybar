// The cc-candybar URL handler: a resident macOS background-only app that
// forwards every `cc-candybar://` link Launch Services hands it to the daemon,
// as one frame, and reads back the daemon's verdict on it. The daemon parses
// the link and opens its signature; this app reads only which daemon signed it.
// Background-only (the Info.plist install writes) is what
// keeps a click from taking the terminal's keyboard focus: Launch Services
// never activates such an app.
//
// [LAW:one-source-of-truth] The app knows a few wire facts, spelled in
// wire.swift with the reads that decide by them, mirrored from
// src/daemon/foundations/protocol.ts, src/daemon/paths.ts and
// src/click/link-signer.ts and pinned by scripts/check-protocol.mjs. The one
// fact spelled here is the socket path, derived from the uid because Launch
// Services starts the app with no shell's environment. A handler goes stale
// through what it knows, and this one knows no bundle path, no node binary and
// no verb; the one thing it knows of the user's tools is the scheme of the
// editor's link to a file on a machine ssh reaches.
//
// [LAW:carrying-cost] No retry. The socket is non-blocking: a connect either
// completes at once (a unix socket with room in its backlog needs no round
// trip) or fails. The waits are bounded, so a daemon that reads nothing cannot
// hold a click for long: one for a frame longer than the socket buffer, which
// lands only as the daemon reads it (WRITE_WAIT_MS), and one for the verdict,
// which the daemon writes as soon as it has read the frame (VERDICT_WAIT_MS),
// or, for a frame that asks for the click's acts, once the click has run
// (LANDED_WAIT_MS: a click that takes longer is told as unconfirmed, and its
// copy is not made). Launch Services delivers the next click on the main
// thread, so a click waits on its socket's own serial queue, in the order it
// arrived, and only carrying out what it asked (the pasteboard, the editor)
// runs on the main thread.
//
// [LAW:no-silent-failure] The app sees four failures: a frame that could not
// be written, a frame written that got no verdict it could read (the click may
// still land, so it is told as unconfirmed, never as lost), a link the
// daemon refused (one the bar never drew, or one changed since), and a click
// the daemon answered it could not take, in the reason it gave: the forward
// worked, so that is told as the daemon's, never as a dead forward. Each is
// written to the unified log under the app's subsystem (`log stream
// --predicate 'subsystem == "com.cccandybar.url-handler"'`) and told to the
// user as a macOS user notification carrying what was observed or the
// daemon's reason, never a diagnosis. A click whose verb fails is not one of
// them: the bar holds that failure, except for a click forwarded over ssh,
// whose bar this Mac never sees, so the daemon says it in the verdict and the
// app tells it. A click that asked the daemon to copy or
// open on this Mac is told when it cannot be carried out here too (an editor
// with no host name, a daemon older than this app, a pasteboard that refused),
// so it never looks to have worked when it did not. A lost click is lost by
// design: the app never starts a
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

// How long a write waits for the daemon to make room in the socket buffer.
// A daemon that is up reads a frame as soon as its loop turns; a bound this
// long is only ever reached by one that is wedged.
let WRITE_WAIT_MS: Int32 = 1000

// How long the app waits for the daemon's verdict on a link it wrote.
let VERDICT_WAIT_MS: Int32 = 1000

// How long it waits when the frame asks for the click's acts: the verdict
// comes after the click has run, and a daemon older than this app answers at
// once, so only a busy or wedged one reaches this bound.
let LANDED_WAIT_MS: Int32 = 5000

// Mirrored: src/daemon/paths.ts defaultSocketPath.
func socketPath() -> String {
  let uid = getuid()
  return "/tmp/cc-candybar-\(uid)/socket"
}

let log = Logger(subsystem: "com.cccandybar.url-handler", category: "forward")

func errnoText(_ what: String) -> String {
  "\(what): \(String(cString: strerror(errno))) (errno \(errno))"
}

// One frame to the route's socket, non-blocking throughout, saying where the
// click's acts go: a frame that says the desktop gets them back with the
// verdict.
func forward(_ url: String, via route: Route) -> Forward {
  let path = route.socket
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

  let bytes = frame(url, actsOn: route.actsOn)
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
  return verdict(
    fd, waiting: route.actsOn == ACTS_ON_DESKTOP ? LANDED_WAIT_MS : VERDICT_WAIT_MS)
}

func isNoSuchFile(_ error: NSError) -> Bool {
  error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError
    || (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code == Int(ENOENT)
}

func listing(of dir: String) -> Directory {
  do {
    return .files(try FileManager.default.contentsOfDirectory(atPath: dir))
  } catch let error as NSError {
    return isNoSuchFile(error) ? .absent : .unreadable(error.localizedDescription)
  }
}

// [LAW:no-silent-failure] A modification time that cannot be read is told: the
// newest forward is chosen by it.
func inspection(of path: String) -> Inspection {
  do {
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    guard let modified = attributes[.modificationDate] as? Date else {
      return .unreadable("it has no modification time")
    }
    return .modified(modified)
  } catch let error as NSError {
    return isNoSuchFile(error) ? .vanished : .unreadable(error.localizedDescription)
  }
}

// The listing and the looks, as the file system gives them; wire.swift decides.
// NSHomeDirectory, not $HOME: it is the account's home, which is what ssh's `%d`
// spells in the stanza.
func route(of link: String) -> Result<Route, ForwardError> {
  let dir = NSHomeDirectory() + "/" + REMOTE_SOCKET_DIR_UNDER_HOME
  return routeOf(
    link, own: socketPath(), directory: dir,
    listing: { listing(of: dir) }, inspect: { inspection(of: dir + "/" + $0) })
}

// A forward file can outlive the ssh connection that made it (ssh killed), and
// a daemon on the far end can be gone behind a live one, so a forward a link
// names that does not take the link says whose it is and what to look at,
// before the cause. [LAW:no-silent-failure]
func deliver(_ url: String, via route: Route) -> Forward {
  let sent = forward(url, via: route)
  guard case .forward(let entry, _) = route, case .failed(let why) = sent else { return sent }
  return .failed(
    "the ssh forward for key \(entry.name.keyId) did not take the link; is the ssh connection to the machine that drew it open? \(why)"
  )
}

// Exactly `count` bytes from the socket by `deadline` (a monotonic ms count),
// or what stopped them.
func readExactly(
  _ fd: Int32, _ count: Int, by deadline: UInt64, waiting: Int32
) -> Result<Data, ForwardError> {
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
      return .failure(ForwardError("the daemon sent no verdict within \(waiting)ms"))
    }
    var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if poll(&ready, 1, Int32(left)) < 0 { return .failure(ForwardError(errnoText("poll"))) }
  }
  return .success(data)
}

func monotonicMs() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000 }

// The daemon's verdict on the link: one frame, read by wire.swift. The longest
// it reads is the longest frame the daemon sends, because a copy's text is in it.
func verdict(_ fd: Int32, waiting: Int32) -> Forward {
  let deadline = monotonicMs() + UInt64(waiting)
  let header: Data
  switch readExactly(fd, FRAME_HEADER_BYTES, by: deadline, waiting: waiting) {
  case .success(let d): header = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  let length = frameLength(header)
  if length > MAX_FRAME_BYTES {
    return .unconfirmed("the daemon's verdict is \(length) bytes, past \(MAX_FRAME_BYTES)")
  }
  let body: Data
  switch readExactly(fd, length, by: deadline, waiting: waiting) {
  case .success(let d): body = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  guard let read = verdictOf(body) else {
    return .unconfirmed("the daemon's verdict is not one this app reads")
  }
  return told(read)
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
let failedClickNotice = "failed-click"

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

// Carries out what the click asked of this Mac, on the main thread, which is
// the one AppKit's pasteboard and workspace are used from. One notice per act
// that could not be carried out, each under its own identifier, the click's
// among them, so neither a click that asked for two things that failed nor a
// click that follows it replaces a notice not yet seen. [LAW:no-silent-failure]
func carryOut(_ steps: [Step], click: UUID) {
  for (index, step) in steps.enumerated() {
    let notice = "act-\(click.uuidString)-\(index)"
    switch step {
    case .copy(let text):
      let pasteboard = NSPasteboard.general
      pasteboard.clearContents()
      if pasteboard.setString(text, forType: .string) {
        log.notice("copied \(text.utf8.count, privacy: .public) bytes to the pasteboard")
      } else {
        log.error("the pasteboard refused \(text.utf8.count, privacy: .public) bytes")
        notify("Copy failed", "the pasteboard refused the text", notice)
      }
    case .open(let link):
      guard let url = URL(string: link) else {
        log.error("not a link: \(link, privacy: .private)")
        notify("Open failed", "the editor's link is not a URL: \(link)", notice)
        continue
      }
      guard NSWorkspace.shared.open(url) else {
        log.error("nothing opened \(link, privacy: .private)")
        notify("Open failed", "no application opened \(link): is VS Code installed?", notice)
        continue
      }
      log.notice("opened \(link, privacy: .private)")
    case .tell(let why):
      log.error("act not carried out: \(why, privacy: .public)")
      notify("Click did nothing here", why, notice)
    case .clickFailed(let why):
      log.error("click failed: \(why, privacy: .public)")
      notify("Click failed", why, notice)
    }
  }
}

// Notice, not info: the unified log persists notice and above, so `log show`
// can answer "did the click reach the socket" after the fact. The link itself
// is private: a copy link carries the text being copied, and the unified log is
// readable by every admin on the machine. The daemon's own click event records
// the link, in the user's own log. [LAW:nothing-unseen]
func conclude(_ link: String, via routed: Route, _ sent: Forward) {
  let socket = routed.socket
  switch sent {
  case .delivered(let acts):
    log.notice("forwarded \(link, privacy: .private) to \(socket, privacy: .public)")
    carryOut(steps(for: acts, via: routed), click: UUID())
  case .refused(let why):
    log.error("refused \(link, privacy: .private) by \(socket, privacy: .public): \(why, privacy: .public)")
    notify("Click refused", why, refusedClickNotice)
  case .unconfirmed(let why):
    log.error("unconfirmed \(link, privacy: .private) at \(socket, privacy: .public): \(why, privacy: .public)")
    notify("Click unconfirmed", why, lostClickNotice)
  case .daemonFailed(let why):
    log.error("failed \(link, privacy: .private) at \(socket, privacy: .public): \(why, privacy: .public)")
    notify("Click failed", why, failedClickNotice)
  case .failed(let why):
    log.error("lost \(link, privacy: .private) to \(socket, privacy: .public): \(why, privacy: .public)")
    notify("Click not delivered", why, lostClickNotice)
  }
}

final class Handler: NSObject, NSApplicationDelegate {
  // One serial queue per socket, made on the main thread Launch Services
  // delivers on: the clicks a daemon is sent are read in the order they were
  // made, and one daemon that is slow to answer holds no other's.
  private var queues: [String: DispatchQueue] = [:]

  private func queue(for socket: String) -> DispatchQueue {
    if let made = queues[socket] { return made }
    let made = DispatchQueue(label: "com.cccandybar.url-handler.\(socket)")
    queues[socket] = made
    return made
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
      let link = url.absoluteString
      switch route(of: link) {
      case .failure(let error):
        log.error("lost \(link, privacy: .private): \(error.why, privacy: .public)")
        notify("Click not delivered", error.why, lostClickNotice)
      case .success(let routed):
        queue(for: routed.socket).async {
          let sent = deliver(link, via: routed)
          DispatchQueue.main.async { conclude(link, via: routed, sent) }
        }
      }
    }
  }
}

let app = NSApplication.shared
let handler = Handler()
app.delegate = handler
app.run()
