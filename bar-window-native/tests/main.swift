import CoreGraphics
import Foundation

func expect(_ condition: @autoclosure () -> Bool, _ explanation: String) {
    if !condition() { fputs("\(explanation)\n", stderr); exit(1) }
}

let first = CGRect(x: -1000, y: 160, width: 9.5, height: 17)
let view = CGRect(x: -1005, y: 159, width: 771, height: 410)
let size = first.size
let empty = CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: size) { _ in first }
expect(empty?.firstCell == first, "A blank line retains the terminal's measured cell size")
expect(empty?.frame(column: 2, row: 22, width: 32, height: 2) ==
       CGRect(x: -981, y: 534, width: 304, height: 34), "Inset offsets are terminal cells on the owning display")
expect(empty?.frame(column: 79, row: 0, width: 2, height: 1) == nil, "Reject a rectangle outside the terminal")
let wide = CGRect(origin: first.origin, size: CGSize(width: 19, height: 17))
expect(CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: size) { _ in wide } == empty,
       "A wide glyph covers two cells")
expect(CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: CGSize(width: 12, height: 17)) { _ in first } == nil,
       "Reject a cell size contradicted by the tty")
expect(CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: size) { _ in first.offsetBy(dx: 0, dy: -34) } == nil,
       "A scrollback character above the clipped viewport cannot locate row zero")
expect(CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: nil) { point in
    point.x < first.maxX ? first : first.offsetBy(dx: first.width, dy: 0)
} == empty, "Two neighboring AX cells can witness size without pixel metrics")
expect(CellGrid.measure(viewport: view, columns: 80, rows: 24, ttyCell: nil) { _ in first } == nil,
       "Without a tty measurement or two adjacent cells, explain the ambiguity")
print("Geometry expectations passed")
