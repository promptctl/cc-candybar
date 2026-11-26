import AppKit
import Carbon

struct TerminalSession {
    let window: CGWindowID
    let selected: Bool
    let minimized: Bool
    let nativeSplits: Int
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

enum ScriptableTerminal: String {
    case iTerm = "com.googlecode.iterm2"
    case terminal = "com.apple.Terminal"

    var name: String { self == .iTerm ? "iTerm2" : "Terminal.app" }

    // [LAW:effects-at-boundaries] No NSAppleScript on the AppKit event thread:
    // synchronous Apple events run on the observer's lookup queue. A preferred
    // window is tried by its stable WindowServer id before enumerating others.
    func session(tty: String, pid: pid_t, preferred: CGWindowID?) throws -> TerminalSession? {
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

        func inWindow(_ id: CGWindowID) throws -> TerminalSession? {
            let w = object("cwin", "ID  ", Descriptor(int32: Int32(bitPattern: id)))
            let selected: Bool
            let splits: Int
            switch self {
            case .iTerm:
                let sessions = every("Trms", of: every("Trmt", of: w))
                // One event for all ttys in this window; no per-session queries.
                let tabs = try items(get(property("Stty", of: sessions))).map { try items($0) }
                guard let tab = tabs.first(where: { $0.contains { $0.stringValue == tty } }) else { return nil }
                let visible = every("Trms", of: property("Crtb", of: w))
                selected = try items(get(property("Stty", of: visible))).contains { $0.stringValue == tty }
                splits = tab.count
            case .terminal:
                let tabs = try items(get(property("ttty", of: every("ttab", of: w))))
                guard tabs.contains(where: { $0.stringValue == tty }) else { return nil }
                selected = try get(property("ttty", of: property("tcnt", of: w))).stringValue == tty
                splits = 1
            }
            return try TerminalSession(window: id, selected: selected,
                                       minimized: get(property("pmnd", of: w)).booleanValue, nativeSplits: splits)
        }
        func find(_ id: CGWindowID) throws -> TerminalSession? {
            do { return try inWindow(id) }
            catch let e as NSError where e.domain == NSOSStatusErrorDomain && e.code == errAENoSuchObject { return nil }
        }
        if let preferred, let found = try find(preferred) { return found }
        let windows = try items(get(property("ID  ", of: every("cwin"))))
        for window in windows {
            let id = CGWindowID(bitPattern: window.int32Value)
            if id != preferred, let found = try find(id) { return found }
        }
        return nil
    }
}
