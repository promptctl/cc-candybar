import Cocoa
import WebKit

let url = URL(string: CommandLine.arguments[1])!
let height = CGFloat(Double(CommandLine.arguments[2])!)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let screen = NSScreen.main!.visibleFrame
let frame = NSRect(x: screen.minX, y: screen.minY, width: screen.width, height: height)
let window = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel, .resizable], backing: .buffered, defer: false)
window.level = .floating
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
window.isMovableByWindowBackground = true
window.hidesOnDeactivate = false
let web = WKWebView(frame: NSRect(origin: .zero, size: frame.size))
web.autoresizingMask = [.width, .height]
window.contentView = web
web.load(URLRequest(url: url))
window.orderFrontRegardless()
app.run()
