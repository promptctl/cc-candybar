import CoreGraphics

// Ghostty's pty reports viewport pixels *without padding*, including the
// incomplete last row/column. When the AX viewport has exactly that extent,
// the origin is proven. Infer integer backing-pixel cell size only if unique.
func unpaddedGhosttyGrid(viewport: CGRect, pixels: CGSize, scale: CGFloat, columns: Int, rows: Int) -> CellGrid? {
    guard scale.isFinite, scale > 0, !viewport.isEmpty, !viewport.isInfinite,
          abs(viewport.width * scale - pixels.width) < 0.01,
          abs(viewport.height * scale - pixels.height) < 0.01 else { return nil }
    func pitch(_ extent: CGFloat, count: Int) -> CGFloat? {
        guard extent > 0, extent < CGFloat(UInt16.max), count > 1, count <= Int(UInt16.max) else { return nil }
        let whole = Int(extent)
        let smallest = whole / (count + 1) + 1
        let largest = whole / count
        return smallest == largest ? CGFloat(largest) / scale : nil
    }
    guard let width = pitch(pixels.width, count: columns), let height = pitch(pixels.height, count: rows) else { return nil }
    return CellGrid(firstCell: CGRect(origin: viewport.origin, size: CGSize(width: width, height: height)),
                    columns: columns, rows: rows)
}

// A terminal-reported pixel measurement and its WindowServer frame are one
// observation. Revalidate after crossing the asynchronous observer boundary.
struct WindowGridSnapshot {
    let frame: CGRect
    let measurement: GridMeasurement

    func measure(frame current: CGRect, columns: Int, rows: Int) -> GridMeasurement {
        guard current == frame else { return .unavailable("Terminal window moved during cell measurement") }
        guard case let .measured(grid) = measurement else { return measurement }
        guard grid.columns == columns, grid.rows == rows,
              let full = grid.frame(column: 0, row: 0, width: columns, height: rows),
              current.insetBy(dx: -0.5, dy: -0.5).contains(full) else {
            return .unavailable("Terminal grid changed during cell measurement")
        }
        return measurement
    }
}
