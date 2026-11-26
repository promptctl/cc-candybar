import AppKit
import Carbon

struct TerminalSession {
    let window: CGWindowID
    let selected: Bool
    let minimized: Bool
    let nativeSplits: Int
    var wezPaneSize: WezPaneSize? = nil
    var reportedGrid: WindowGridSnapshot? = nil
}

enum TerminalLocation {
    case window(TerminalSession)
    case hidden(String)
    case missing

    var windowID: CGWindowID? {
        if case let .window(session) = self { return session.window }
        return nil
    }
}

struct LocationFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

// The object specifiers below follow each installed app's scripting dictionary.
// Apple events carry the tty as data and address the observed application PID.
private typealias Descriptor = NSAppleEventDescriptor
private func code(_ fourCharacters: StaticString) -> FourCharCode {
    precondition(fourCharacters.utf8CodeUnitCount == 4)
    return fourCharacters.withUTF8Buffer { $0.reduce(0) { ($0 << 8) | UInt32($1) } }
}

private func object(_ type: StaticString, _ form: StaticString, _ value: Descriptor,
                    of parent: Descriptor = .null()) -> Descriptor {
    let record = Descriptor.record()
    record.setDescriptor(Descriptor(typeCode: code(type)), forKeyword: AEKeyword(keyAEDesiredClass))
    record.setDescriptor(Descriptor(enumCode: code(form)), forKeyword: AEKeyword(keyAEKeyForm))
    record.setDescriptor(value, forKeyword: AEKeyword(keyAEKeyData))
    record.setDescriptor(parent, forKeyword: AEKeyword(keyAEContainer))
    return record.coerce(toDescriptorType: typeObjectSpecifier)!
}

private func property(_ name: StaticString, of parent: Descriptor) -> Descriptor {
    object("prop", "prop", Descriptor(typeCode: code(name)), of: parent)
}

private func every(_ type: StaticString, of parent: Descriptor = .null()) -> Descriptor {
    let all = Descriptor(descriptorType: typeAbsoluteOrdinal, data: Descriptor(typeCode: code("all ")).data)!
    return object(type, "indx", all, of: parent)
}

private func items(_ result: Descriptor) throws -> [Descriptor] {
    guard result.descriptorType == typeAEList else { throw LocationFailure("Terminal returned an invalid list") }
    return (0..<result.numberOfItems).map { result.atIndex($0 + 1)! }
}

enum LocalTerminal: String {
    case iTerm = "com.googlecode.iterm2"
    case terminal = "com.apple.Terminal"
    case ghostty = "com.mitchellh.ghostty"
    case kitty = "net.kovidgoyal.kitty"
    case wezTerm = "com.github.wez.wezterm"

    var name: String {
        switch self {
        case .iTerm: return "iTerm2"
        case .terminal: return "Terminal.app"
        case .ghostty: return "Ghostty"
        case .kitty: return "kitty"
        case .wezTerm: return "WezTerm"
        }
    }

    var requiresSessionPolling: Bool { self == .kitty || self == .wezTerm || self == .ghostty }

    // [LAW:effects-at-boundaries] No NSAppleScript on the AppKit event thread:
    // synchronous Apple events run on the observer's lookup queue. A preferred
    // window is tried by its stable WindowServer id before enumerating others.
    func session(tty: String, clientPID: pid_t, pid: pid_t, preferred: CGWindowID?) throws -> TerminalLocation {
        func failure(_ status: Int, _ detail: String?) -> NSError {
            let message = status == errAEEventNotPermitted ? "Automation permission denied for \(name)" :
                "\(name) Automation: " + (detail ?? "error \(status)")
            return NSError(domain: NSOSStatusErrorDomain, code: status, userInfo: [NSLocalizedDescriptionKey: message])
        }
        func get(_ target: Descriptor) throws -> Descriptor {
            let event = Descriptor(eventClass: kAECoreSuite, eventID: kAEGetData,
                                   targetDescriptor: Descriptor(processIdentifier: pid),
                                   returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
            event.setParam(target, forKeyword: keyDirectObject)
            let reply: Descriptor
            do { reply = try event.sendEvent(options: [.waitForReply, .neverInteract], timeout: 2) }
            catch let error as NSError { throw failure(error.code, error.localizedDescription) }
            if let error = reply.paramDescriptor(forKeyword: keyErrorNumber), error.int32Value != 0 {
                throw failure(Int(error.int32Value), reply.paramDescriptor(forKeyword: keyErrorString)?.stringValue)
            }
            guard let value = reply.paramDescriptor(forKeyword: keyDirectObject) else {
                throw LocationFailure("\(name) returned no value for a terminal property")
            }
            return value
        }

        func ghosttySession() throws -> TerminalLocation {
            let windows = try items(get(every("Gwnd")))
            for w in windows {
                let tabs = try items(get(every("Gtab", of: w)))
                for tab in tabs {
                    let ttys = try items(get(property("Gtty", of: every("Gtrm", of: tab))))
                    guard ttys.contains(where: { $0.stringValue == tty }) else { continue }
                    guard try get(property("GTsl", of: tab)).booleanValue else { return .hidden("Another Ghostty tab is selected") }
                    let title = try get(property("pnam", of: w)).stringValue
                    let titles = try items(get(property("pnam", of: every("Gwnd")))).map(\.stringValue)
                    let native = try nativeWindow(pid: pid, title: title, titles: titles, terminal: name)
                    return .window(TerminalSession(window: native.id, selected: true, minimized: native.minimized,
                                                   nativeSplits: ttys.count))
                }
            }
            return .missing
        }
        typealias Tab = (selected: Bool, splits: Int)
        func iTermTab(_ w: Descriptor) throws -> Tab? {
            let sessions = every("Trms", of: every("Trmt", of: w))
            let tabs = try items(get(property("Stty", of: sessions))).map { try items($0) }
            guard let tab = tabs.first(where: { $0.contains { $0.stringValue == tty } }) else { return nil }
            let visible = every("Trms", of: property("Crtb", of: w))
            return try (items(get(property("Stty", of: visible))).contains { $0.stringValue == tty }, tab.count)
        }
        func terminalTab(_ w: Descriptor) throws -> Tab? {
            let tabs = try items(get(property("ttty", of: every("ttab", of: w))))
            guard tabs.contains(where: { $0.stringValue == tty }) else { return nil }
            return try (get(property("ttty", of: property("tcnt", of: w))).stringValue == tty, 1)
        }
        let tabForWindow: (Descriptor) throws -> Tab?
        switch self {
        case .iTerm: tabForWindow = iTermTab
        case .terminal: tabForWindow = terminalTab
        case .ghostty: return try ghosttySession()
        case .kitty, .wezTerm:
            return try remoteSession(terminal: self, tty: tty, clientPID: clientPID, pid: pid, preferred: preferred)
        }
        func find(_ id: CGWindowID) throws -> TerminalSession? {
            do {
                let w = object("cwin", "ID  ", Descriptor(int32: Int32(bitPattern: id)))
                guard let tab = try tabForWindow(w) else { return nil }
                return try TerminalSession(window: id, selected: tab.selected,
                                           minimized: get(property("pmnd", of: w)).booleanValue, nativeSplits: tab.splits)
            } catch let e as NSError where e.domain == NSOSStatusErrorDomain && e.code == errAENoSuchObject { return nil }
        }
        if let preferred, let found = try find(preferred) { return .window(found) }
        let windows = try items(get(property("ID  ", of: every("cwin"))))
        for window in windows {
            let id = CGWindowID(bitPattern: window.int32Value)
            if id != preferred, let found = try find(id) { return .window(found) }
        }
        return .missing
    }
}
