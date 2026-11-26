import AppKit
import ApplicationServices

private enum Refresh: Int {
    case position, grid, session
}

private let onAXEvent: AXObserverCallback = { _, element, notification, context in
    guard let context else { return }
    let observer = Unmanaged<WindowObserver>.fromOpaque(context).takeUnretainedValue()
    observer.received(element, notification as String)
}

private func screenFrame(_ id: CGWindowID, pid: pid_t) throws -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]] else {
        throw LocationFailure("WindowServer could not list terminal window \(id)")
    }
    guard let row = info.first else { return nil }
    guard row[kCGWindowOwnerPID as String] as? pid_t == pid else { throw LocationFailure("Terminal window owner changed") }
    guard row[kCGWindowIsOnscreen as String] as? Bool == true else { return nil }
    guard let bounds = row[kCGWindowBounds as String] as? NSDictionary,
          let frame = CGRect(dictionaryRepresentation: bounds), !frame.isEmpty else {
        throw LocationFailure("WindowServer returned invalid bounds for terminal window \(id)")
    }
    return frame
}

final class WindowObserver {
    private let client: AttachedClient
    private var tty: String { client.tty }
    private var terminal: ScriptableTerminal { client.terminal }
    private var previousDisplay: Display?
    private var targetWindow: AXUIElement?
    private var scrollBar: AXUIElement?
    private var exitWatch: DispatchSourceProcess?
    private let report: (TerminalObservation) -> Void
    private var listeners = [(NotificationCenter, NSObjectProtocol)]()
    private var drag: Any?
    private var ax: AXObserver?
    private var axApp: AXUIElement?
    private var pid: pid_t?
    private var identity: Result<TerminalSession?, Error>?
    private var preferred: CGWindowID?
    private var generation: UInt64 = 0
    private var looking = false
    private var last: TerminalObservation?
    private var scheduled: Refresh?

    init(client: AttachedClient, report: @escaping (TerminalObservation) -> Void) {
        self.client = client
        self.report = report
    }

    private func listen(_ center: NotificationCenter, _ name: Notification.Name,
                        _ effect: @escaping (Notification) -> Void) {
        listeners.append((center, center.addObserver(forName: name, object: nil, queue: .main, using: effect)))
    }

    func start(onClientExit: @escaping () -> Void) {
        let watch = DispatchSource.makeProcessSource(identifier: client.pid, eventMask: .exit, queue: .main)
        watch.setEventHandler { [weak self] in
            self?.report(.unavailable("Attaching tmux client exited"))
            onClientExit()
        }
        watch.activate()
        exitWatch = watch
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                     NSWorkspace.didHideApplicationNotification, NSWorkspace.didUnhideApplicationNotification,
                     NSWorkspace.didActivateApplicationNotification, NSWorkspace.didDeactivateApplicationNotification] {
            listen(workspace, name) { [weak self] note in
                guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                      app.bundleIdentifier == self.terminal.rawValue else { return }
                self.invalidate(.session)
            }
        }
        for name in [NSWorkspace.activeSpaceDidChangeNotification, NSWorkspace.sessionDidBecomeActiveNotification,
                     NSWorkspace.sessionDidResignActiveNotification, NSWorkspace.screensDidWakeNotification] {
            listen(workspace, name) { [weak self] _ in self?.invalidate(.session) }
        }
        listen(.default, NSApplication.didChangeScreenParametersNotification) { [weak self] _ in self?.invalidate(.grid) }
        for name in ["com.apple.screenIsLocked", "com.apple.screenIsUnlocked"] {
            listen(DistributedNotificationCenter.default(), Notification.Name(name)) { [weak self] _ in self?.invalidate(.session) }
        }
        drag = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDragged) { [weak self] _ in
            guard let self, self.preferred != nil, self.pid == NSWorkspace.shared.frontmostApplication?.processIdentifier
            else { return }
            self.invalidate(.position)
        }
        refresh(.session)
    }

    deinit {
        for (center, token) in listeners { center.removeObserver(token) }
        exitWatch?.cancel()
        if let drag { NSEvent.removeMonitor(drag) }
        detachAX()
    }

    fileprivate func invalidate(_ change: Refresh) {
        if let previous = scheduled {
            if change.rawValue > previous.rawValue { scheduled = change }
            return
        }
        scheduled = change
        DispatchQueue.main.async { [weak self] in
            guard let self, let change = self.scheduled else { return }
            self.scheduled = nil
            self.refresh(change)
        }
    }

    private func detachAX() {
        if let ax { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(ax), .commonModes) }
        scrollBar = nil
        targetWindow = nil
        ax = nil
        axApp = nil
        pid = nil
        invalidateIdentity()
        preferred = nil
    }

    private func observe(_ app: NSRunningApplication) throws {
        if pid == app.processIdentifier { return }
        detachAX()
        let element = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.5)
        var observer: AXObserver?
        let created = AXObserverCreate(app.processIdentifier, onAXEvent, &observer)
        guard created == .success, let observer else { throw LocationFailure("Accessibility observer: \(created.rawValue)") }
        let notices = [kAXWindowMovedNotification, kAXWindowResizedNotification, kAXWindowMiniaturizedNotification,
                       kAXWindowDeminiaturizedNotification, kAXMainWindowChangedNotification,
                       kAXFocusedWindowChangedNotification, kAXFocusedUIElementChangedNotification,
                       kAXSelectedChildrenChangedNotification, kAXLayoutChangedNotification,
                       kAXUIElementDestroyedNotification, kAXWindowCreatedNotification]
        for notice in notices {
            let result = AXObserverAddNotification(observer, element, notice as CFString,
                                                   Unmanaged.passUnretained(self).toOpaque())
            guard result == .success || result == .notificationUnsupported else {
                throw LocationFailure("\(terminal.name) Accessibility \(notice): \(result.rawValue)")
            }
        }
        ax = observer
        axApp = element
        pid = app.processIdentifier
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    }

    fileprivate func received(_ element: AXUIElement, _ notice: String) {
        if let targetWindow {
            let notifiedWindow: AXUIElement?
            if attribute(element, kAXRoleAttribute) as? String == kAXWindowRole {
                notifiedWindow = element
            } else if let window = attribute(element, kAXWindowAttribute), CFGetTypeID(window) == AXUIElementGetTypeID() {
                notifiedWindow = unsafeBitCast(window, to: AXUIElement.self)
            } else { notifiedWindow = nil }
            if let notifiedWindow, !CFEqual(targetWindow, notifiedWindow) { return }
        }
        switch notice {
        case kAXWindowMovedNotification: invalidate(.position)
        case kAXValueChangedNotification, kAXWindowResizedNotification: invalidate(.grid)
        default: invalidate(.session)
        }
    }

    private func observeScroll(_ element: AXUIElement) {
        guard let ax, scrollBar.map({ CFEqual($0, element) }) != true else { return }
        if let scrollBar { AXObserverRemoveNotification(ax, scrollBar, kAXValueChangedNotification as CFString) }
        let result = AXObserverAddNotification(ax, element, kAXValueChangedNotification as CFString,
                                               Unmanaged.passUnretained(self).toOpaque())
        scrollBar = result == .success ? element : nil
    }

    private func invalidateIdentity() {
        generation &+= 1
        identity = nil
    }

    private func lookup(pid: pid_t) {
        guard !looking else { return }
        looking = true
        let revision = generation
        let (terminal, tty, preferred) = (self.terminal, self.tty, self.preferred)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let result = Result { try terminal.session(tty: tty, pid: pid, preferred: preferred) }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.looking = false
                // [LAW:no-ambient-temporal-coupling] A tab may change during
                // discovery. A stale answer cannot show the previous tab.
                if self.generation == revision, self.pid == pid {
                    self.identity = result
                    self.preferred = (try? result.get())?.window
                }
                self.invalidate(.grid)
            }
        }
    }

    private func sample(_ change: Refresh) throws -> TerminalObservation {
        if (CGSessionCopyCurrentDictionary() as? [String: Any])?["CGSSessionScreenIsLocked"] as? Bool == true {
            return .hidden("Screen locked")
        }
        guard AXIsProcessTrusted() else { throw LocationFailure("Accessibility permission required for the bar window") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: terminal.rawValue).first else {
            detachAX()
            throw LocationFailure("\(terminal.name) is not running")
        }
        try observe(app)
        if change == .session { invalidateIdentity() }
        guard let identity else {
            try client.verify()
            lookup(pid: app.processIdentifier)
            return .hidden("Locating terminal tab")
        }
        guard let session = try identity.get() else { throw LocationFailure("\(terminal.name) has no local window for \(tty)") }
        guard session.selected else { return .hidden("Another terminal tab is selected") }
        guard !session.minimized, !app.isHidden, let frame = try screenFrame(session.window, pid: app.processIdentifier) else {
            return .hidden("Terminal window is hidden, minimized or on another Space")
        }
        let display = Display.containing(frame)
        let sameDisplay = previousDisplay == display
        previousDisplay = display
        if change == .position, sameDisplay, case let .visible(id, old, grid) = last,
           id == session.window, old.size == frame.size {
            let translated: GridMeasurement
            if case let .measured(measurement) = grid {
                translated = .measured(CellGrid(firstCell: measurement.firstCell.offsetBy(
                    dx: frame.minX - old.minX, dy: frame.minY - old.minY),
                    columns: measurement.columns, rows: measurement.rows))
            } else { translated = grid }
            return .visible(window: id, frame: frame, grid: translated)
        }
        guard let ttyGrid = TTYGrid(tty: tty, display: display) else {
            return .visible(window: session.window, frame: frame, grid: .unavailable("Cannot read attaching tty grid dimensions"))
        }
        targetWindow = axApp.flatMap { accessibleWindow(app: $0, frame: frame) }
        let grid = targetWindow.map {
            measureGrid(window: $0, frame: frame, session: session, tty: ttyGrid, watchScroll: observeScroll)
        } ?? .unavailable("Accessibility could not identify this terminal's cell grid")
        return .visible(window: session.window, frame: frame, grid: grid)
    }

    private func refresh(_ change: Refresh) {
        let snapshot: TerminalObservation
        do { snapshot = try sample(change) }
        catch { snapshot = .unavailable(error.localizedDescription) }
        if snapshot != last { last = snapshot; report(snapshot) }
    }
}
