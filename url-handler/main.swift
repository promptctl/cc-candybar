// The cc-candybar URL handler: a resident macOS background-only app that
// forwards every `cc-candybar://` link Launch Services hands it to the daemon,
// as one frame, and reads back the daemon's verdict on it. The daemon parses
// the link and opens its signature; this app reads only which daemon signed it.
// Background-only (the Info.plist install writes) is what
// keeps a click from taking the terminal's keyboard focus: Launch Services
// never activates such an app.
//
// [LAW:one-source-of-truth] The wire facts this app knows live in wire.swift,
// with the reads the app decides by; this file is the I/O around them: the
// socket, the pasteboard, the editor and the notification center. A handler
// goes stale through what it knows, and this one knows nothing a release
// changes: not a bundle path, not a node binary, not a verb.
//
// A link drawn by a daemon on another machine (the terminal is an ssh session)
// goes to that daemon through the user's ssh forward, and its copy and open
// act here: the frame says so (`actsOn`), the daemon hands the acts back with
// the verdict once the click has landed, and this app carries them out on this
// Mac. [LAW:single-enforcer] A local link is told nothing of this and acts as
// it always did, on the daemon's own machine, which is this one.
//
// [LAW:carrying-cost] The socket is non-blocking: a connect either completes
// at once (a unix socket with room in its backlog needs no round trip) or
// fails. Every wait is bounded, so a daemon that reads nothing cannot hold this
// app: a frame longer than the socket buffer lands only as the daemon reads it
// (WRITE_WAIT_MS), a local link's verdict is written as soon as the daemon has
// read the frame (VERDICT_WAIT_MS), and a forwarded link's verdict is written
// once its click has landed (LANDED_WAIT_MS). The waits run on a serial queue
// per socket, never on the main thread, which is the thread Launch Services
// delivers the next click on; the pasteboard and the editor are the main
// thread's.
//
// [LAW:no-silent-failure] The app sees these failures: a frame that could not
// be written, a frame written that got no verdict it could read (the click may
// still land, so it is told as unconfirmed, never as lost), a link the daemon
// refused (one the bar never drew, or one changed since), and an act it was
// handed and could not carry out (no host name to point the editor at, no
// editor to open it). Each is written to the unified log under the app's
// subsystem (`log stream --predicate 'subsystem ==
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

// How long a write waits for the daemon to make room in the socket buffer.
// A daemon that is up reads a frame as soon as its loop turns; a bound this
// long is only ever reached by one that is wedged.
let WRITE_WAIT_MS: Int32 = 1000

// How long the app waits for the daemon's verdict on a local link, which the
// daemon writes as soon as it has read the frame, before the click runs.
let VERDICT_WAIT_MS: Int32 = 1000

// How long the app waits for the verdict on a forwarded link, which the daemon
// writes after the click has landed: a copy or open runs a program, bounded at
// five seconds, and the verdict crosses an ssh connection.
let LANDED_WAIT_MS: Int32 = 15000

// The longest verdict the app reads: a reason and the acts it hands back,
// never a frame of the bar.
let VERDICT_MAX_BYTES = 65536

let log = Logger(subsystem: "com.cccandybar.url-handler", category: "forward")

enum Forward {
  case verdict(Verdict)
  // The frame was written, and no verdict on it could be read.
  case unconfirmed(String)
  case failed(String)
}

func errnoText(_ what: String) -> String {
  "\(what): \(String(cString: strerror(errno))) (errno \(errno))"
}

// One frame to the daemon's socket, non-blocking throughout, and its verdict.
func forward(_ url: String, to path: String, actsOnDesktop: Bool) -> Forward {
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

  let bytes = frame(url, actsOnDesktop: actsOnDesktop)
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
  return verdict(fd, waitMs: actsOnDesktop ? LANDED_WAIT_MS : VERDICT_WAIT_MS)
}

// Where a link goes: this Mac's own daemon, or the forward its signer's id
// names. A bar drawn by a daemon on another machine is signed by that daemon,
// and only the daemon that signed a link opens it; the user's ssh forwards that
// daemon's socket to `<key id>.<host>.sock` in REMOTE_SOCKET_DIR_UNDER_HOME
// (`cc-candybar ssh-config` on that machine prints the lines). No route and no
// key is learned, nothing is tried in turn, and no daemon sees a link that is
// not its own. A link that names no forward on this Mac, its own or one whose
// ssh connection is not set up, goes to this Mac's daemon, which says which
// daemon signed it. [LAW:single-enforcer]
enum Route {
  case own(socket: String)
  case forward(name: ForwardName, socket: String)

  var socket: String {
    switch self {
    case .own(let socket), .forward(_, let socket): return socket
    }
  }

  // [LAW:dataflow-not-control-flow] The route says where a click's acts happen:
  // on this Mac when a forward carried the link, which is the one case the
  // daemon's machine is not the person's.
  var actsOnDesktop: Bool {
    if case .forward = self { return true }
    return false
  }

  var host: String? {
    if case .forward(let name, _) = self { return name.host }
    return nil
  }
}

func route(of link: String) -> Route {
  guard let id = signerId(of: link) else { return .own(socket: socketPath(uid: getuid())) }
  // NSHomeDirectory, not $HOME: it is the account's home, which is what ssh's
  // `%d` spells in the stanza.
  let dir = NSHomeDirectory() + "/" + REMOTE_SOCKET_DIR_UNDER_HOME
  let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []).map {
    name -> (name: String, modified: Date) in
    let attrs = try? FileManager.default.attributesOfItem(atPath: dir + "/" + name)
    return (name, attrs?[.modificationDate] as? Date ?? .distantPast)
  }
  guard let found = forwardFile(for: id, among: files) else {
    return .own(socket: socketPath(uid: getuid()))
  }
  return .forward(name: found.name, socket: dir + "/" + found.file)
}

// A forward file can outlive the ssh connection that made it (ssh killed), and
// a daemon on the far end can be gone behind a live one, so a forward a link
// names that does not take the link says whose it is and what to look at,
// before the cause. [LAW:no-silent-failure]
func deliver(_ url: String, via route: Route) -> Forward {
  let sent = forward(url, to: route.socket, actsOnDesktop: route.actsOnDesktop)
  guard case .forward(let name, _) = route, case .failed(let why) = sent else { return sent }
  return .failed(
    "the ssh forward for key \(name.id) did not take the link; is the ssh connection to the machine that drew it open? \(why)"
  )
}

struct ForwardError: Error {
  let why: String
  init(_ why: String) { self.why = why }
}

func monotonicMs() -> UInt64 { clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000 }

// Exactly `count` bytes from the socket by `deadline` (a monotonic ms count),
// or what stopped them.
func readExactly(_ fd: Int32, _ count: Int, by deadline: UInt64, waited waitMs: Int32)
  -> Result<Data, ForwardError>
{
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
      return .failure(ForwardError("the daemon sent no verdict within \(waitMs)ms"))
    }
    var ready = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    if poll(&ready, 1, Int32(left)) < 0 { return .failure(ForwardError(errnoText("poll"))) }
  }
  return .success(data)
}

// The daemon's verdict on the link: one frame, read by `verdictOf`.
func verdict(_ fd: Int32, waitMs: Int32) -> Forward {
  let deadline = monotonicMs() + UInt64(waitMs)
  let header: Data
  switch readExactly(fd, FRAME_HEADER_BYTES, by: deadline, waited: waitMs) {
  case .success(let d): header = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  let length = header.reduce(0) { ($0 << 8) | Int($1) }
  if length > VERDICT_MAX_BYTES {
    return .unconfirmed("the daemon's verdict is \(length) bytes, past \(VERDICT_MAX_BYTES)")
  }
  let body: Data
  switch readExactly(fd, length, by: deadline, waited: waitMs) {
  case .success(let d): body = d
  case .failure(let e): return .unconfirmed(e.why)
  }
  let read = verdictOf(body)
  if case .unreadable = read.said {
    return .unconfirmed("the daemon's verdict is not one this app reads")
  }
  return .verdict(read)
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
let uncarriedActNotice = "uncarried-act"

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

// What the daemon handed back, done on this Mac, by the main thread. The
// copied text and the opened path are private to the log, as the link is: the
// unified log is readable by every admin on the machine.
func carryOut(_ steps: [Step]) {
  for step in steps {
    switch step {
    case .copy(let text):
      let board = NSPasteboard.general
      board.clearContents()
      if board.setString(text, forType: .string) {
        log.notice("copied \(text.utf8.count) bytes to the pasteboard")
      } else {
        log.error("the pasteboard refused \(text.utf8.count) bytes")
        notify("Copy failed", "the pasteboard refused the text", uncarriedActNotice)
      }
    case .open(let url):
      NSWorkspace.shared.open(url, configuration: NSWorkspace.OpenConfiguration()) { _, error in
        if let error = error {
          log.error("opening \(url, privacy: .private) failed: \(error.localizedDescription, privacy: .public)")
          notify(
            "Open failed",
            "no editor took \(url.absoluteString) (VS Code with its Remote - SSH extension handles it): \(error.localizedDescription)",
            uncarriedActNotice)
        } else {
          log.notice("opened \(url, privacy: .private)")
        }
      }
    case .cannot(let why):
      log.error("not carried out: \(why, privacy: .public)")
      notify("Click not carried out", why, uncarriedActNotice)
    }
  }
}

final class Handler: NSObject, NSApplicationDelegate {
  // One serial queue per socket: clicks to one daemon land in the order they
  // were made, and a daemon slow to answer holds only its own.
  private var queues: [String: DispatchQueue] = [:]

  private func queue(for socket: String) -> DispatchQueue {
    if let queue = queues[socket] { return queue }
    let queue = DispatchQueue(label: "cc-candybar.url-handler.\(socket)")
    queues[socket] = queue
    return queue
  }

  func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls {
      let link = url.absoluteString
      let routed = route(of: link)
      queue(for: routed.socket).async {
        let sent = deliver(link, via: routed)
        DispatchQueue.main.async { Handler.conclude(link, routed, sent) }
      }
    }
  }

  // Notice, not info: the unified log persists notice and above, so
  // `log show` can answer "did the click reach the socket" after the fact.
  // The link itself is private: a copy link carries the text being copied,
  // and the unified log is readable by every admin on the machine. The
  // daemon's own click event records the link, in the user's own log.
  // [LAW:nothing-unseen]
  static func conclude(_ link: String, _ routed: Route, _ sent: Forward) {
    let socket = routed.socket
    switch sent {
    case .verdict(let read):
      // The acts are what the click came to, so they are carried out whether
      // the click landed or failed after asking them.
      carryOut(plan(read.acts, host: routed.host))
      switch read.said {
      case .delivered, .unreadable:
        log.notice("forwarded \(link, privacy: .private) to \(socket, privacy: .public)")
      case .refused(let why):
        log.error("refused \(link, privacy: .private) by \(socket, privacy: .public): \(why, privacy: .public)")
        notify("Click refused", why, refusedClickNotice)
      case .failed(let why):
        log.error("lost \(link, privacy: .private) to \(socket, privacy: .public): \(why, privacy: .public)")
        notify("Click not delivered", why, lostClickNotice)
      }
    case .unconfirmed(let why):
      log.error("unconfirmed \(link, privacy: .private) at \(socket, privacy: .public): \(why, privacy: .public)")
      notify("Click unconfirmed", why, lostClickNotice)
    case .failed(let why):
      log.error("lost \(link, privacy: .private) to \(socket, privacy: .public): \(why, privacy: .public)")
      notify("Click not delivered", why, lostClickNotice)
    }
  }
}

let app = NSApplication.shared
let handler = Handler()
app.delegate = handler
app.run()
