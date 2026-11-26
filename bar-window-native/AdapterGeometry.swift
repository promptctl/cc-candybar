import CoreGraphics

// The tty extent can include a partial trailing cell. Keep it when estimating
// padding and discard it when deriving the cell pitch in backing pixels.
func estimatedGrid(in bounds: CGRect, pixels: CGSize, scale: CGFloat, columns: Int, rows: Int,
                   bottomPaddingInRows: CGFloat? = nil) -> CellGrid? {
    guard scale.isFinite, scale > 0, !bounds.isEmpty, !bounds.isInfinite,
          columns > 0, rows > 0, pixels.width > 0, pixels.height > 0 else { return nil }
    let width = pixels.width / scale, height = pixels.height / scale
    let cell = CGSize(width: floor(pixels.width / CGFloat(columns)) / scale,
                      height: floor(pixels.height / CGFloat(rows)) / scale)
    let spareX = bounds.width - width, spareY = bounds.height - height
    guard spareX >= 0, spareY >= 0, cell.width > 0, cell.height > 0 else { return nil }
    // A text viewport excludes chrome. For a decorated window, anchor to the
    // bottom so title and tab bars above the grid do not move the last row.
    let top = bottomPaddingInRows.map { max(0, spareY - $0 * cell.height) } ?? spareY / 2
    return CellGrid(firstCell: CGRect(origin: CGPoint(x: bounds.minX + spareX / 2, y: bounds.minY + top),
                                      size: cell), columns: columns, rows: rows)
}

// WezTerm's CLI reports the pixel extent of complete cells, including on
// releases where Accessibility exposes only the decorated window frame.
struct WezPaneSize: Decodable {
    let cols, rows, pixel_width, pixel_height: Int

    func measure(in frame: CGRect, scale: CGFloat?, columns: Int, rows ttyRows: Int) -> GridMeasurement {
        guard cols == columns, rows == ttyRows else { return .remeasuring("WezTerm pane was resized") }
        guard let scale, let grid = estimatedGrid(in: frame, pixels: CGSize(width: pixel_width, height: pixel_height),
                                                  scale: scale, columns: cols, rows: rows, bottomPaddingInRows: 0.5)
        else { return .unavailable("WezTerm pane dimensions do not fit its window") }
        return .measured(grid)
    }
}

// A terminal-reported pixel measurement and its WindowServer frame are one
// observation. Revalidate after crossing the asynchronous observer boundary.
struct WindowGridSnapshot {
    let frame: CGRect
    let measurement: GridMeasurement

    func measure(frame current: CGRect, columns: Int, rows: Int) -> GridMeasurement {
        guard current == frame else { return .remeasuring("Terminal window moved during cell measurement") }
        guard case let .measured(grid) = measurement else { return measurement }
        guard grid.columns == columns, grid.rows == rows,
              let full = grid.frame(column: 0, row: 0, width: columns, height: rows),
              current.insetBy(dx: -0.5, dy: -0.5).contains(full) else {
            return .remeasuring("Terminal grid changed during cell measurement")
        }
        return measurement
    }
}
