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

private func frameOf(_ node: AXUIElement) -> CGRect? {
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

    func measure(_ tty: TTYGrid) -> CellGrid? {
        // iTerm updates its accessibility index here. AXValue would return the
        // terminal contents; measurement needs only the character positions.
        guard attribute(text, kAXNumberOfCharactersAttribute) != nil else { return nil }
        return CellGrid.measure(viewport: viewport, columns: tty.columns, rows: tty.rows, ttyCell: tty.cell) { point in
            var p = point
            guard let location = AXValueCreate(.cgPoint, &p),
                  let range = parameter(text, kAXRangeForPositionParameterizedAttribute, location)
            else { return nil }
            var rect = CGRect.zero
            return unpack(parameter(text, kAXBoundsForRangeParameterizedAttribute, range),
                          .cgRect, into: &rect) ? rect : nil
        }
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

func measureGrid(window: AXUIElement, frame: CGRect, session: TerminalSession, tty: TTYGrid, watchScroll: (AXUIElement) -> Void) -> GridMeasurement {
    guard session.nativeSplits == 1 else {
        return .unavailable("Several native terminal splits share this tab; the cell grid is ambiguous")
    }
    var inHistory = false
    var viewports = [TextViewport]()
    func walk(_ node: AXUIElement, clip: CGRect) {
        let role = attribute(node, kAXRoleAttribute) as? String
        if role == kAXTextAreaRole {
            if let box = frameOf(node) {
                let viewport = clip.intersection(box)
                if !viewport.isEmpty { viewports.append(TextViewport(text: node, viewport: viewport)) }
            }
            return
        }
        if role == kAXScrollAreaRole, let bar = attribute(node, kAXVerticalScrollBarAttribute),
           CFGetTypeID(bar) == AXUIElementGetTypeID() {
            let scroll = unsafeBitCast(bar, to: AXUIElement.self)
            watchScroll(scroll)
            if let value = attribute(scroll, kAXValueAttribute) as? NSNumber, value.doubleValue < 1 {
                inHistory = true
            }
        }
        let childClip = role == kAXScrollAreaRole ? clip.intersection(frameOf(node) ?? clip) : clip
        guard !childClip.isEmpty else { return }
        for child in attribute(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
            walk(child, clip: childClip)
        }
    }
    walk(window, clip: frame)
    guard !inHistory else { return .unavailable("Terminal is showing scrollback") }
    guard viewports.count == 1, let grid = viewports.first?.measure(tty) else {
        return .unavailable("Could not measure an unambiguous terminal cell grid")
    }
    return .measured(grid)
}
