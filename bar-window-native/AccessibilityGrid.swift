import AppKit
import ApplicationServices

func attribute(_ node: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, name as CFString, &result) == .success else { return nil }
    return result
}

private func unpack<T>(_ value: CFTypeRef?, _ type: AXValueType, into target: inout T) -> Bool {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return false }
    let ax = unsafeBitCast(value, to: AXValue.self)
    guard AXValueGetType(ax) == type else { return false }
    return withUnsafeMutablePointer(to: &target) { AXValueGetValue(ax, type, $0) }
}

func frameOf(_ node: AXUIElement) -> CGRect? {
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard unpack(attribute(node, kAXPositionAttribute), .cgPoint, into: &origin),
          unpack(attribute(node, kAXSizeAttribute), .cgSize, into: &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

private func parameter(_ node: AXUIElement, _ name: String, _ input: CFTypeRef) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(node, name as CFString, input, &result) == .success
    else { return nil }
    return result
}

struct TextViewport {
    let text: AXUIElement
    let viewport: CGRect
    let scrollBar: AXUIElement?
    let showingHistory: Bool
    let scrollable: Bool

    func measure(_ tty: TTYGrid, terminal: LocalTerminal) -> CellGrid? {
        // iTerm updates its accessibility index here. AXValue would return the
        // terminal contents; measurement needs only the character positions.
        guard attribute(text, kAXNumberOfCharactersAttribute) != nil else { return nil }
        func cellAt(_ point: CGPoint) -> CGRect? {
            var p = point
            guard let location = AXValueCreate(.cgPoint, &p),
                  let range = parameter(text, kAXRangeForPositionParameterizedAttribute, location)
            else { return nil }
            var rect = CGRect.zero
            return unpack(parameter(text, kAXBoundsForRangeParameterizedAttribute, range),
                          .cgRect, into: &rect) ? rect : nil
        }
        func read(_ size: CGSize?) -> CellGrid? {
            CellGrid.measure(viewport: viewport, columns: tty.columns, rows: tty.rows, ttyCell: size, cellAt: cellAt)
        }
        // Terminal.app writes logical points into the winsize pixel fields on
        // Retina. Validate those units against AX's own glyph bounds.
        if terminal == .terminal, tty.pixels.width > 0, tty.pixels.height > 0 {
            let points = CGSize(width: tty.pixels.width / CGFloat(tty.columns), height: tty.pixels.height / CGFloat(tty.rows))
            if let grid = read(points) { return grid }
        }
        return read(tty.cell)
    }
}

func accessibleWindow(app: AXUIElement, frame: CGRect) -> AXUIElement? {
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let matches = windows.filter { element in
        guard let box = frameOf(element) else { return false }
        return abs(box.minX - frame.minX) < 1 && abs(box.minY - frame.minY) < 1 &&
            abs(box.width - frame.width) < 1 && abs(box.height - frame.height) < 1
    }
    return matches.count == 1 ? matches.first : nil
}

func measureGrid(window: AXUIElement, frame: CGRect, session: TerminalSession, terminal: LocalTerminal, tty: TTYGrid, watchScroll: (AXUIElement) -> Bool) -> GridMeasurement {
    guard session.nativeSplits == 1 else {
        return .unavailable("Several native \(terminal.name) splits share this tab; the cell grid is ambiguous")
    }
    var viewports = [TextViewport]()
    var visited = Set<AXUIElement>()
    func walk(_ node: AXUIElement, clip: CGRect, scrollBar: AXUIElement?) {
        guard visited.insert(node).inserted else { return }
        let role = attribute(node, kAXRoleAttribute) as? String
        if role == kAXTextAreaRole {
            if let box = frameOf(node) {
                let viewport = clip.intersection(box)
                if !viewport.isEmpty {
                    viewports.append(TextViewport(text: node, viewport: viewport, scrollBar: scrollBar,
                                                  showingHistory: box.maxY > clip.maxY + 1,
                                                  scrollable: box.height > clip.height + 1))
                }
            }
            return
        }
        var bar = scrollBar
        var bounds = clip
        if role == kAXScrollAreaRole {
            bounds = clip.intersection(frameOf(node) ?? clip)
            if let value = attribute(node, kAXVerticalScrollBarAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() {
                bar = unsafeBitCast(value, to: AXUIElement.self)
            } else { bar = nil }
        }
        guard !bounds.isEmpty else { return }
        for child in attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
            walk(child, clip: bounds, scrollBar: bar)
        }
    }
    walk(window, clip: frame, scrollBar: nil)
    guard viewports.count == 1, let viewport = viewports.first else {
        return .unavailable("\(terminal.name) does not expose a unique terminal text viewport")
    }
    // A toolbelt's scroll view may be beside the terminal. Only the scrollbar
    // enclosing the identified terminal text can invalidate its grid.
    if let bar = viewport.scrollBar {
        guard attribute(bar, kAXRoleAttribute) as? String == kAXScrollBarRole,
              watchScroll(bar), let position = attribute(bar, kAXValueAttribute) as? NSNumber else {
            return .unavailable("Cannot observe the terminal scroll position")
        }
        // Terminal.app exposes an empty scroll range as a disabled bar at
        // zero. Its document fits the viewport, so no history can be visible.
        let emptyRange = attribute(bar, kAXEnabledAttribute) as? Bool == false && !viewport.scrollable
        if !emptyRange && position.doubleValue < 1 { return .unavailable("Terminal is showing scrollback") }
    } else if viewport.scrollable { return .unavailable("Cannot observe the terminal scroll position") }
    guard !viewport.showingHistory else { return .unavailable("Terminal is showing scrollback") }
    if let grid = viewport.measure(tty, terminal: terminal) { return .measured(grid) }
    if terminal == .ghostty, let scale = tty.backingScale, viewport.scrollBar != nil,
       let grid = unpaddedGhosttyGrid(viewport: viewport.viewport, pixels: tty.pixels, scale: scale,
                                      columns: tty.columns, rows: tty.rows) { return .measured(grid) }
    return .unavailable("\(terminal.name) did not expose an unambiguous cell origin and size")
}
