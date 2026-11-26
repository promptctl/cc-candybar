import AppKit
import Darwin

// [LAW:single-enforcer] The attaching tmux client owns the terminal. A shell
// living in Claude's pane can outlive both its original terminal and SSH login.
private func processInfo(_ pid: pid_t) throws -> kinfo_proc {
    var info = kinfo_proc()
    var size = MemoryLayout.size(ofValue: info)
    var query: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&query, 4, &info, &size, nil, 0) == 0, size == MemoryLayout.size(ofValue: info) else {
        throw LocationFailure("Cannot identify the attaching client process \(pid)")
    }
    return info
}

struct AttachedClient {
    let pid: pid_t
    let tty: String
    private let device: dev_t
    private let start: timeval
    let terminal: LocalTerminal
    let terminalPID: pid_t

    init(pid: pid_t, tty: String) throws {
        var terminalDevice = stat()
        guard tty.hasPrefix("/dev/"), stat(tty, &terminalDevice) == 0,
              terminalDevice.st_mode & S_IFMT == S_IFCHR else {
            throw LocationFailure("Attaching client has no terminal device at \(tty)")
        }
        self.pid = pid
        self.tty = tty
        self.device = terminalDevice.st_rdev
        let info = try processInfo(pid)
        self.start = info.kp_proc.p_starttime
        guard info.kp_eproc.e_tdev == device else { throw LocationFailure("Client \(pid) does not own \(tty)") }
        (self.terminal, self.terminalPID) = try terminalAncestor(pid: pid, tty: tty)
    }

    func verify() throws {
        let info = try processInfo(pid)
        let stamp = info.kp_proc.p_starttime
        guard info.kp_eproc.e_tdev == device, stamp.tv_sec == start.tv_sec, stamp.tv_usec == start.tv_usec else {
            throw LocationFailure("Original attaching client on \(tty) ended")
        }
    }
}

private func terminalAncestor(pid: pid_t, tty: String) throws -> (LocalTerminal, pid_t) {
    var current = pid
    var visited = Set<pid_t>()
    while current > 1, visited.insert(current).inserted {
        var info = try processInfo(current)
        let command = withUnsafeBytes(of: &info.kp_proc.p_comm) {
            String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        if ["sshd", "sshd-session", "sshd-auth"].contains(command) {
            throw LocationFailure("SSH client on \(tty) has no local terminal window")
        }
        var path = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        if proc_pidpath(current, &path, UInt32(path.count)) > 0 {
            let url = URL(fileURLWithPath: String(cString: path))
            // Terminal helpers can be separate binaries inside the app bundle.
            // Start at the outermost application so an embedded helper cannot
            // claim the session in its own name.
            if let appPart = url.pathComponents.firstIndex(where: { $0.hasSuffix(".app") }) {
                let path = NSString.path(withComponents: Array(url.pathComponents[...appPart]))
                // The daemon can attach before LaunchServices publishes an
                // NSRunningApplication in this bootstrap session. Helpers and
                // bundled CLI tools cannot claim the enclosing app's identity.
                if let appBundle = Bundle(path: path), let executable = appBundle.executableURL,
                   let bundle = appBundle.bundleIdentifier {
                    var actual = stat(), declared = stat()
                    if stat(url.path, &actual) == 0, stat(executable.path, &declared) == 0,
                       actual.st_dev == declared.st_dev, actual.st_ino == declared.st_ino {
                        guard let terminal = LocalTerminal(rawValue: bundle) else {
                            throw LocationFailure("Unsupported terminal: \(URL(fileURLWithPath: path).lastPathComponent) (\(bundle))")
                        }
                        return (terminal, current)
                    }
                }
            }
        }
        current = info.kp_eproc.e_ppid
    }
    throw LocationFailure("No local terminal application owns the attaching client on \(tty)")
}

// Convert the terminal driver's measured pixels to points on the display
// containing the largest part of this window. A window may straddle displays.
struct Display: Equatable {
    let id: CGDirectDisplayID
    let scale: CGFloat

    static func containing(_ frame: CGRect) -> Display? {
        NSScreen.screens.compactMap { screen -> (CGFloat, Display)? in
            guard let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 else { return nil }
            let intersection = CGDisplayBounds(id).intersection(frame)
            return intersection.isEmpty ? nil : (intersection.width * intersection.height,
                                                  Display(id: id, scale: screen.backingScaleFactor))
        }.max(by: { $0.0 < $1.0 })?.1
    }
}

struct TTYGrid {
    let columns: Int
    let rows: Int
    let cell: CGSize?
    let pixels: CGSize
    let backingScale: CGFloat?

    init?(tty: String, display: Display?) {
        let fd = open(tty, O_RDONLY | O_NONBLOCK | O_NOCTTY | O_CLOEXEC)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var size = winsize()
        guard ioctl(fd, TIOCGWINSZ, &size) == 0, size.ws_col > 0, size.ws_row > 0 else { return nil }
        columns = Int(size.ws_col)
        rows = Int(size.ws_row)
        pixels = CGSize(width: Int(size.ws_xpixel), height: Int(size.ws_ypixel))
        backingScale = display?.scale
        if let scale = display?.scale, size.ws_xpixel > 0, size.ws_ypixel > 0 {
            cell = CGSize(width: CGFloat(size.ws_xpixel) / CGFloat(columns) / scale,
                          height: CGFloat(size.ws_ypixel) / CGFloat(rows) / scale)
        } else { cell = nil }
    }
}
