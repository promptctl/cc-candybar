import AppKit

func writeObservation(_ observation: TerminalObservation) {
    func rect(_ value: CGRect) -> [String: CGFloat] {
        ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
    }
    let output: [String: Any]
    switch observation {
    case .locating: output = ["kind": "hidden", "reason": "Locating terminal tab"]
    case let .visible(window, frame, measurement):
        let grid: [String: Any]
        switch measurement {
        case let .measured(cells):
            grid = ["kind": "measured", "cell": rect(cells.firstCell), "rows": cells.rows, "columns": cells.columns]
        case let .remeasuring(reason), let .unavailable(reason): grid = ["kind": "unavailable", "reason": reason]
        }
        output = ["kind": "visible", "window": window, "frame": rect(frame), "grid": grid]
    case let .hidden(reason): output = ["kind": "hidden", "reason": reason]
    case let .unavailable(reason): output = ["kind": "unavailable", "reason": reason]
    }
    writeMessage(output)
}

func writeMessage(_ output: [String: Any]) {
    do {
        var bytes = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
        bytes.append(0x0a)
        try FileHandle.standardOutput.write(contentsOf: bytes)
    } catch {
        fputs("bar-window: cannot publish geometry: \(error.localizedDescription)\n", stderr)
        exit(EXIT_FAILURE)
    }
}

let args = CommandLine.arguments
if args.count == 4, args[1] == "panel" {
    do {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let panel = try WindowPanel(page: URL(fileURLWithPath: args[2]), lockPath: args[3])
        panel.followInput()
        withExtendedLifetime(panel) { app.run() }
    } catch {
        writeMessage(["kind": "unavailable", "reason": error.localizedDescription])
        exit(EXIT_FAILURE)
    }
}
guard args.count == 4, args[1] == "observe", let pid = pid_t(args[3]), pid > 1 else {
    fputs("usage: cc-candybar-window observe <attaching-client-tty> <attaching-client-pid>\n", stderr)
    exit(EX_USAGE)
}
do {
    let client = try AttachedClient(pid: pid, tty: args[2])
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let observer = WindowObserver(client: client, report: writeObservation)
    observer.start { exit(EXIT_SUCCESS) }
    withExtendedLifetime(observer) { app.run() }
} catch {
    writeObservation(.unavailable(error.localizedDescription))
    exit(EXIT_FAILURE)
}
