import AppKit
import Darwin

// Ghostty and WezTerm use private logical window IDs in their public APIs.
// Match both sides of the mapping uniquely; a duplicate title, colocated
// window or transient sheet cannot select an arbitrary neighbor.
func nativeWindow(pid: pid_t, title: String?, titles: [String?], terminal: String) throws -> (id: CGWindowID, minimized: Bool) {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    let windows = (attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []).filter {
        attribute($0, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole
    }
    let matches: [AXUIElement]
    if let title, !title.isEmpty, titles.filter({ $0 == title }).count == 1 {
        matches = windows.filter { attribute($0, kAXTitleAttribute) as? String == title }
    } else if titles.count == 1 && windows.count == 1 && (title?.isEmpty ?? true) {
        matches = windows
    } else { matches = [] }
    guard matches.count == 1, let window = matches.first, let frame = frameOf(window),
          let rows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], 0) as? [[String: Any]] else {
        throw LocationFailure("\(terminal) cannot uniquely associate its tty with a native window")
    }
    let numbers = rows.compactMap { row -> CGWindowID? in
        guard row[kCGWindowOwnerPID as String] as? pid_t == pid, row[kCGWindowLayer as String] as? Int == 0,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let box = CGRect(dictionaryRepresentation: bounds), !box.isEmpty, box == frame else { return nil }
        return row[kCGWindowNumber as String] as? CGWindowID
    }
    guard numbers.count == 1, let id = numbers.first else {
        throw LocationFailure("\(terminal) cannot uniquely verify its native window frame")
    }
    return (id, attribute(window, kAXMinimizedAttribute) as? Bool ?? false)
}

// Discover listening endpoints only on the already verified terminal PID.
// No session environment, history or terminal text is needed for discovery.
private func endpoint(pid: pid_t, terminal: LocalTerminal) throws -> String {
    let stride = MemoryLayout<proc_fdinfo>.stride
    let bytes = Int(proc_pidinfo(pid, PROC_PIDLISTFDS, 0, nil, 0))
    guard bytes > 0 else { throw LocationFailure("Cannot inspect \(terminal.name)'s local control socket") }
    var fds = [proc_fdinfo](repeating: proc_fdinfo(), count: bytes / stride + 32)
    let capacity = Int32(fds.count * stride)
    let got = proc_pidinfo(pid, PROC_PIDLISTFDS, 0, &fds, capacity)
    guard got > 0 && got < capacity && Int(got) % stride == 0 else {
        throw LocationFailure("Could not enumerate \(terminal.name)'s local control sockets")
    }
    var candidates = Set<String>()
    for fd in fds.prefix(Int(got) / stride) where fd.proc_fdtype == PROX_FDTYPE_SOCKET {
        var sock = socket_fdinfo()
        let size = MemoryLayout.size(ofValue: sock)
        guard proc_pidfdinfo(pid, fd.proc_fd, PROC_PIDFDSOCKETINFO, &sock, Int32(size)) == size,
              sock.psi.soi_kind == SOCKINFO_UN, sock.psi.soi_type == SOCK_STREAM,
              sock.psi.soi_options & Int16(SO_ACCEPTCONN) != 0 else { continue }
        let path = withUnsafeBytes(of: &sock.psi.soi_proto.pri_un.unsi_addr.ua_sun.sun_path) {
            String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        var info = stat()
        guard path.hasPrefix("/"), lstat(path, &info) == 0, info.st_mode & S_IFMT == S_IFSOCK,
              info.st_uid == getuid() else { continue }
        if terminal == .wezTerm, URL(fileURLWithPath: path).lastPathComponent != "gui-sock-\(pid)" { continue }
        candidates.insert(path)
    }
    guard candidates.count == 1, let path = candidates.first else {
        throw LocationFailure("\(terminal.name) requires an identifiable, authorized local control socket")
    }
    return path
}

// Only documented, read-only queries against the identified GUI's bundled
// CLI. Bound both time and reply size on the observer's background queue.
private func query(_ app: NSRunningApplication, _ tool: String, _ args: [String], env: [String: String] = [:]) throws -> Data {
    guard let bundle = app.bundleURL else { throw LocationFailure("Terminal application bundle is missing") }
    let task = Process(), pipe = Pipe()
    task.executableURL = bundle.appendingPathComponent("Contents/MacOS").appendingPathComponent(tool)
    task.arguments = args
    task.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin"].merging(env) { _, value in value }
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = pipe
    task.standardError = FileHandle.nullDevice
    try task.run()
    pipe.fileHandleForWriting.closeFile()
    defer { if task.isRunning { task.terminate() } }
    let deadline = ProcessInfo.processInfo.systemUptime + 2
    let fd = pipe.fileHandleForReading.fileDescriptor
    var data = Data(), chunk = [UInt8](repeating: 0, count: 8192)
    while data.count <= 1024 * 1024 {
        var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0, poll(&descriptor, 1, Int32(remaining * 1000)) > 0 else { break }
        let count = read(fd, &chunk, chunk.count)
        if count == 0 {
            // A CLI may close stdout before exiting.
            while task.isRunning && ProcessInfo.processInfo.systemUptime < deadline { usleep(1000) }
            if !task.isRunning, task.terminationStatus == 0 { return data }
            break
        }
        guard count > 0 else { break }
        data.append(contentsOf: chunk.prefix(count))
    }
    throw LocationFailure("\(app.localizedName ?? tool) local control query failed or was denied")
}

private struct KittyLayout: Decodable {
    let rootPID: pid_t
    let window: CGWindowID
    let selected, history, decorated: Bool
    let columns, rows: Int
    let x, y, left, top, width, height, scaleX, scaleY: CGFloat

    var grid: GridMeasurement {
        if history { return .unavailable("kitty is showing scrollback") }
        guard !decorated else { return .unavailable("kitty did not report the origin below its pane title") }
        guard scaleX > 0, scaleY > 0, width > 0, height > 0, columns > 0, rows > 0 else {
            return .unavailable("kitty returned invalid terminal cell geometry")
        }
        return .measured(CellGrid(firstCell: CGRect(x: x + left / scaleX, y: y + top / scaleY,
                                                    width: width / scaleX, height: height / scaleY),
                                  columns: columns, rows: rows))
    }
}

private struct WezPane: Decodable {
    let window_id, tab_id, pane_id: Int
    let window_title, workspace: String
    let tty_name: String?
    let is_zoomed: Bool
}

private struct WezClient: Decodable {
    let pid: pid_t
    let focused_pane_id: Int?
    let workspace: String
}

func remoteSession(terminal: LocalTerminal, tty: String, clientPID: pid_t, pid: pid_t, preferred: CGWindowID?) throws -> TerminalLocation {
    guard let app = NSRunningApplication(processIdentifier: pid), app.bundleIdentifier == terminal.rawValue else {
        throw LocationFailure("\(terminal.name) process changed")
    }
    let path = try endpoint(pid: pid, terminal: terminal)
    if terminal == .kitty {
        let sessionPID = getsid(clientPID)
        guard sessionPID > 1, let image = Bundle.main.executableURL else {
            throw LocationFailure("Cannot identify kitty's attaching tty session")
        }
        let reporter = image.deletingLastPathComponent().appendingPathComponent("terminal-adapters/kitty_geometry.py")
        guard FileManager.default.isReadableFile(atPath: reporter.path) else {
            throw LocationFailure("kitty geometry reporter is missing")
        }
        func layout() throws -> KittyLayout? {
            let data = try query(app, "kitten", ["@", "--use-password", "never", "--to", "unix:" + path, "kitten",
                                                 "--match", "pid:\(sessionPID)", reporter.path])
            guard !data.isEmpty else { return nil }
            let layout = try JSONDecoder().decode(KittyLayout.self, from: data)
            guard layout.rootPID == sessionPID, layout.window > 0 else { throw LocationFailure("kitty returned another tty session") }
            return layout
        }
        // Bracket the app's absolute cell coordinates with the window frame so
        // a move, resize or tab detachment cannot publish stale screen points.
        let known = try preferred ?? layout()?.window
        guard let id = known else { return .missing }
        let before = try screenFrame(id, pid: pid, onscreenOnly: false)
        guard let sample = try layout() else { return .missing }
        let after = try screenFrame(sample.window, pid: pid, onscreenOnly: false)
        guard let frame = after else { throw LocationFailure("kitty window no longer exists") }
        let measured: GridMeasurement = id == sample.window && before == frame ? sample.grid :
            .remeasuring("kitty window changed during cell measurement")
        return .window(TerminalSession(window: sample.window, selected: sample.selected, minimized: false, nativeSplits: 1,
                                       reportedGrid: WindowGridSnapshot(frame: frame, measurement: measured)))
    }

    let environment = ["WEZTERM_UNIX_SOCKET": path]
    func list<T: Decodable>(_ type: T.Type, _ command: String) throws -> T {
        try JSONDecoder().decode(type, from: query(app, "wezterm", ["--skip-config", "cli", "--no-auto-start", command, "--format", "json"], env: environment))
    }
    let panes = try list([WezPane].self, "list")
    let matches = panes.filter { $0.tty_name == tty }
    guard let pane = matches.first else { return .missing }
    guard matches.count == 1 else { throw LocationFailure("WezTerm reports several panes for this tty") }
    let clients = try list([WezClient].self, "list-clients").filter { $0.pid == pid }
    guard clients.count == 1, let gui = clients.first else { throw LocationFailure("WezTerm did not identify its GUI client") }
    guard gui.workspace == pane.workspace else { return .hidden("WezTerm pane belongs to an inactive workspace") }
    let windows = Dictionary(grouping: panes.filter { $0.workspace == gui.workspace }, by: \.window_id)
    let siblings = windows[pane.window_id] ?? []
    let native = try nativeWindow(pid: pid, title: pane.window_title, titles: windows.values.map { $0.first?.window_title },
                                  terminal: terminal.name)
    let tabs = Dictionary(grouping: siblings, by: \.tab_id)
    var selected = true
    if tabs.count > 1 {
        guard let id = gui.focused_pane_id,
              let active = siblings.first(where: { $0.pane_id == id }) else {
            throw LocationFailure("WezTerm did not identify the selected tab for this window")
        }
        selected = pane.tab_id == active.tab_id
    }
    let splits = tabs[pane.tab_id] ?? []
    if splits.contains(where: \.is_zoomed) { selected = selected && pane.is_zoomed }
    return .window(TerminalSession(window: native.id, selected: selected, minimized: native.minimized, nativeSplits: splits.count))
}
