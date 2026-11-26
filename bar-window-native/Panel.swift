import AppKit
import WebKit

private final class BarPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private enum Placement {
    case docked
    case inset(column: Int, row: Int, width: Int, height: Int)
    case hidden
}

private struct Viewer: Hashable {
    let pid: Int32
    let tty: String

    init(_ fields: [String: Any]) throws {
        guard let tty = fields["tty"] as? String, tty.hasPrefix("/dev/"),
              let pid = fields["pid"] as? Int32, pid > 1 else {
            throw LocationFailure("Invalid attaching tty or pid")
        }
        self.tty = tty
        self.pid = pid
    }
}

private final class WatchedViewer {
    var observer: WindowObserver?
    var observation: TerminalObservation = .locating
    var announced: NSDictionary?
}

final class WindowPanel: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private let panel: NSPanel
    private let page: URL
    private let web: WKWebView
    private let lock: Int32
    private var viewers = [Viewer: WatchedViewer]()
    private var selected: Viewer?
    private var observation: TerminalObservation {
        guard let selected else { return .hidden("Claude's tmux pane is not on screen") }
        return viewers[selected]?.observation ?? .locating
    }
    private var placement: Placement = .hidden
    private var loaded = false
    private var rowCount = 1
    private var revision = 0
    private var hasPresentedFrame = false
    private var lastState = ""
    private var metrics = CGSize.zero
    // Docked windows use their own font when the terminal supplies no grid.
    // Inset placement always requires actual measured terminal cells.
    private let dockFontSize: CGSize = {
        let font = NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)
        return CGSize(width: ("0" as NSString).size(withAttributes: [.font: font]).width,
                      height: NSLayoutManager().defaultLineHeight(for: font))
    }()

    init(page: URL, lockPath: String) throws {
        self.page = page.standardizedFileURL
        guard FileManager.default.isReadableFile(atPath: page.path) else {
            throw LocationFailure("Missing bundled window page at \(page.path)")
        }
        // [LAW:single-enforcer] Only the holder may reserve cells, subscribe
        // to the handoff, or present. A dead helper drops its kernel lock.
        lock = open(lockPath, O_RDWR | O_CREAT | O_EXLOCK | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lock >= 0 else { throw LocationFailure("Cannot own session window: \(String(cString: strerror(errno)))") }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        panel = BarPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                         backing: .buffered, defer: false)
        super.init()
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.hasShadow = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .ignoresCycle]
        panel.contentView = web
        web.navigationDelegate = self
        config.userContentController.add(self, name: "panel")
        web.loadFileURL(self.page, allowingReadAccessTo: self.page.deletingLastPathComponent())
        writeMessage(["kind": "owned"])
    }

    deinit { close(lock) }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true &&
                        navigationAction.request.url?.standardizedFileURL == page ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        align()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("WebKit content process ended") }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.standardizedFileURL == page,
              let event = message.body as? [String: Any], let kind = event["kind"] as? String,
              ["press", "hover", "presented"].contains(kind) else { return }
        if kind == "presented", !hasPresentedFrame {
            hasPresentedFrame = true
            align()
        }
        writeMessage(event)
    }

    private func fail(_ reason: String) {
        panel.orderOut(nil)
        writeMessage(["kind": "unavailable", "reason": reason])
        exit(EXIT_FAILURE)
    }

    private func state(_ kind: String, _ reason: String = "") {
        let token = kind + "\n" + reason
        guard token != lastState else { return }
        lastState = token
        writeMessage(["kind": kind, "reason": reason])
    }

    private func align() {
        func hide(_ kind: String, _ reason: String) {
            hasPresentedFrame = false
            if panel.isVisible { panel.orderOut(nil) }
            state(kind, reason)
        }
        guard loaded else { return }
        switch observation {
        case .locating: hide("hidden", "Locating terminal tab")
        case let .hidden(reason): hide("hidden", reason)
        case let .unavailable(reason): hide("unavailable", reason)
        case let .visible(id, window, grid):
            let cell: CGSize
            if case let .measured(cells) = grid { cell = cells.firstCell.size }
            else { cell = dockFontSize }
            let frame: CGRect
            switch placement {
            case .hidden: hide("hidden", "Claude's tmux pane is not on screen"); return
            case .docked:
                guard let primary = NSScreen.screens.first else { hide("unavailable", "No active display"); return }
                let screens = NSScreen.screens.map {
                    CGRect(x: $0.frame.minX, y: primary.frame.maxY - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height)
                }
                guard let dock = dockedFrame(window: window, height: cell.height * CGFloat(rowCount), screens: screens) else {
                    hide("hidden", "Terminal is outside the active displays")
                    return
                }
                frame = dock
            case let .inset(x, y, width, height):
                switch grid {
                case let .unavailable(reason): hide("unavailable", reason); return
                case let .measured(cells):
                    guard let box = cells.frame(column: x, row: y, width: width, height: height) else {
                        hide("hidden", "Reserved pane is outside the terminal viewport"); return
                    }
                    frame = box
                }
            }
            guard let primary = NSScreen.screens.first else { hide("unavailable", "No active display"); return }
            let native = CGRect(x: frame.minX, y: primary.frame.maxY - frame.maxY, width: frame.width, height: frame.height)
            if panel.frame != native { panel.setFrame(native, display: true, animate: false) }
            if cell != metrics {
                metrics = cell
                web.callAsyncJavaScript("window.metrics(height, width)", arguments: ["width": cell.width, "height": cell.height],
                                         in: nil, in: .page) { [weak self] result in
                    if case let .failure(error) = result { self?.fail(error.localizedDescription) }
                }
            }
            if hasPresentedFrame { panel.order(.above, relativeTo: Int(id)) }
            state("ready")
        }
    }

    private func observe(_ requested: [Viewer]) {
        let current = Set(requested)
        viewers = viewers.filter { current.contains($0.key) }
        for viewer in requested where viewers[viewer] == nil {
            let watched = WatchedViewer()
            viewers[viewer] = watched
            do {
                let owner = try AttachedClient(pid: viewer.pid, tty: viewer.tty)
                let observer = WindowObserver(client: owner) { [weak self, weak watched] value in
                    guard let self, let watched, self.viewers[viewer] === watched else { return }
                    self.update(viewer, watched, value)
                }
                watched.observer = observer
                observer.start { [weak watched] in watched?.observer = nil }
            } catch { update(viewer, watched, .unavailable(error.localizedDescription)) }
        }
        align()
    }

    private func update(_ viewer: Viewer, _ watched: WatchedViewer, _ value: TerminalObservation) {
        watched.observation = value
        var message: [String: Any] = ["kind": "availability", "tty": viewer.tty, "pid": viewer.pid]
        switch value {
        case .locating: message["state"] = "locating"
        case let .hidden(reason): message["state"] = "hidden"; message["reason"] = reason
        case let .unavailable(reason): message["state"] = "unavailable"; message["reason"] = reason
        case let .visible(_, _, grid):
            message["state"] = "visible"
            switch grid {
            case let .measured(cells): message["columns"] = cells.columns; message["rows"] = cells.rows
            case let .unavailable(reason): message["reason"] = reason
            }
        }
        // Moving a window updates the panel in-process. Only a change in
        // candidate eligibility or grid dimensions wakes the tmux reconciler.
        let summary = message as NSDictionary
        if watched.announced != summary {
            watched.announced = summary
            writeMessage(message)
        }
        if selected == viewer { align() }
    }

    func receive(_ command: [String: Any]) throws {
        switch command["kind"] as? String {
        case "clients":
            guard let clients = command["clients"] as? [[String: Any]] else { throw LocationFailure("Missing attaching clients") }
            try observe(clients.map(Viewer.init))
        case "layout":
            let mode = command["placement"] as? String
            selected = mode == "hidden" ? nil : try Viewer(command)
            switch mode {
            case "hidden": placement = .hidden
            case "docked": placement = .docked
            case "inset":
                guard let x = command["column"] as? Int, let y = command["row"] as? Int,
                      let width = command["width"] as? Int, let height = command["height"] as? Int else {
                    throw LocationFailure("Missing reserved tmux pane bounds")
                }
                placement = .inset(column: x, row: y, width: width, height: height)
            default: throw LocationFailure("Unknown window placement")
            }
            align()
        case "frame":
            guard loaded, let rows = command["rows"] as? [[String: Any]], let sequence = command["revision"] as? Int,
                  sequence > revision else { throw LocationFailure("Invalid presentation frame") }
            revision = sequence
            let nextHeight = max(rows.count, 1)
            if rowCount != nextHeight {
                rowCount = nextHeight
                align()
            }
            web.callAsyncJavaScript("window.present(frame)", arguments: ["frame": command], in: nil, in: .page) { [weak self] result in
                if case let .failure(error) = result { self?.fail(error.localizedDescription) }
            }
        default: throw LocationFailure("Unknown panel command")
        }
    }

    func followInput() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            do {
                var buffer = Data()
                var chunk = [UInt8](repeating: 0, count: 65536)
                while true {
                    let count = chunk.withUnsafeMutableBytes { Darwin.read(STDIN_FILENO, $0.baseAddress, $0.count) }
                    if count == 0 { break }
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw LocationFailure("Cannot read window commands: \(String(cString: strerror(errno)))") }
                    buffer.append(contentsOf: chunk.prefix(count))
                    while let newline = buffer.firstIndex(of: 10) {
                        let line = buffer[..<newline]
                        guard line.count <= 16 * 1024 * 1024,
                              let command = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                            throw LocationFailure("Invalid window command")
                        }
                        buffer.removeSubrange(...newline)
                        try DispatchQueue.main.sync { try self.receive(command) }
                    }
                    guard buffer.count <= 16 * 1024 * 1024 else { throw LocationFailure("Window command exceeded 16 MiB") }
                }
                guard buffer.isEmpty else { throw LocationFailure("Incomplete window command") }
                DispatchQueue.main.async { exit(EXIT_SUCCESS) }
            } catch {
                let reason = error.localizedDescription
                DispatchQueue.main.async { self.fail(reason) }
            }
        }
    }
}
