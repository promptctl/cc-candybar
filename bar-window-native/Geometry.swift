import CoreGraphics
import Foundation

// [LAW:one-source-of-truth] AX, WindowServer and tmux all locate things from
// the top left. Stay in those points until the NSPanel boundary.
struct CellGrid: Equatable {
    let firstCell: CGRect
    let columns: Int
    let rows: Int

    func frame(column: Int, row: Int, width: Int, height: Int) -> CGRect? {
        guard column >= 0, row >= 0, width > 0, height > 0,
              column <= columns - width, row <= rows - height else { return nil }
        return CGRect(x: firstCell.minX + CGFloat(column) * firstCell.width,
                      y: firstCell.minY + CGFloat(row) * firstCell.height,
                      width: CGFloat(width) * firstCell.width,
                      height: CGFloat(height) * firstCell.height)
    }

    // A cell's box comes from the terminal's own layout. Padding, scrollbars
    // and split dividers are outside the grid; dividing the view includes them.
    static func measure(viewport: CGRect, columns: Int, rows: Int, ttyCell: CGSize?,
                        cellAt: (CGPoint) -> CGRect?) -> CellGrid? {
        guard columns > 0, rows > 0, !viewport.isEmpty, !viewport.isInfinite else { return nil }
        // Ask for the clipped top-left character. In an empty line iTerm
        // returns a newline's box; it still starts at column zero. Asking to
        // its right can return a character on the following line.
        let lineHeight = ttyCell?.height ?? viewport.height / CGFloat(rows)
        let probe = CGPoint(x: viewport.minX + 0.25, y: viewport.minY + lineHeight / 2)
        guard let glyph = cellAt(probe), glyph.width > 0, glyph.height > 0 else { return nil }
        let size: CGSize
        if let cell = ttyCell {
            // TIOCGWINSZ measures pixels for the entire tty; conversion to
            // points can round by one pixel over the entire row or column.
            let span = (glyph.width / cell.width).rounded()
            guard (1...2).contains(span), abs(glyph.width - span * cell.width) < 1,
                  abs(glyph.height - cell.height) < 1 else { return nil }
            size = CGSize(width: glyph.width / span, height: glyph.height)
        } else {
            let next = cellAt(CGPoint(x: glyph.maxX + glyph.width / 2, y: glyph.midY))
            guard let next, abs(next.minX - glyph.maxX) <= 1,
                  next.minY == glyph.minY, next.width == glyph.width else { return nil }
            size = glyph.size
        }
        let grid = CellGrid(firstCell: CGRect(origin: glyph.origin, size: size), columns: columns, rows: rows)
        guard let full = grid.frame(column: 0, row: 0, width: columns, height: rows),
              viewport.insetBy(dx: -0.5, dy: -0.5).contains(full) else { return nil }
        return grid
    }
}

enum GridMeasurement: Equatable {
    case measured(CellGrid)
    case unavailable(String)
}

// [LAW:types-are-the-program] Docking requires a window; only the inset
// placement requires the text grid. Losing the latter cannot erase the former.
enum TerminalObservation: Equatable {
    case locating
    case visible(window: UInt32, frame: CGRect, grid: GridMeasurement)
    case hidden(String)
    case unavailable(String)
}

// All rectangles are in WindowServer points. A full-width footer can be
// covered by two displays even when neither display contains it alone.
func dockedFrame(window: CGRect, height: CGFloat, screens: [CGRect]) -> CGRect? {
    let visible = screens.compactMap { screen -> (CGRect, CGFloat)? in
        let part = screen.intersection(window)
        return part.isEmpty ? nil : (screen, part.width * part.height)
    }
    guard height > 0, let anchor = visible.max(by: { $0.1 < $1.1 })?.0 else { return nil }
    let below = CGRect(x: window.minX, y: window.maxY, width: window.width, height: height)
    let pieces = screens.map { $0.intersection(below) }.filter { !$0.isEmpty }
    let edges = Set([below.minY, below.maxY] + pieces.flatMap { [$0.minY, $0.maxY] }).sorted()
    let covered = zip(edges, edges.dropFirst()).allSatisfy { low, high in
        let spans = pieces.filter { $0.minY <= low && $0.maxY >= high }.sorted { $0.minX < $1.minX }
        var right = below.minX
        for span in spans {
            if span.minX > right { return false }
            right = max(right, span.maxX)
        }
        return right >= below.maxX
    }
    if covered { return below }
    return CGRect(x: window.minX, y: min(window.maxY, anchor.maxY) - height,
                  width: window.width, height: height)
}
