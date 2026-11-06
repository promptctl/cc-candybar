// The one thing the URL handler reads in a link: the renderer it is addressed
// to, from which the socket file it writes the link to follows. Everything
// after the name is the renderer's to read.
//
// [LAW:one-source-of-truth] Mirrored from src/click/wire.ts (the address
// segment) and src/daemon/home.ts (the name rule and the socket file a name
// selects), pinned by scripts/check-protocol.mjs. Every fact here is one a
// link's grammar fixes, so the app, which outlives daemon upgrades, never
// holds one a release changes.

// Mirrored: src/click/wire.ts LINK_TO.
let LINK_TO = "to"
// Mirrored: src/daemon/home.ts MAIN_NAME, MAIN_SOCKET_FILE,
// NAMED_SOCKET_SUFFIX and RENDERER_NAME_MAX.
let MAIN_NAME = "main"
let MAIN_SOCKET_FILE = "socket"
let NAMED_SOCKET_SUFFIX = ".sock"
let RENDERER_NAME_MAX = 32

// The socket file a link selects in the per-uid directory, or why it selects
// none.
enum Target: Equatable {
  case file(String)
  case refused(String)
}

// [LAW:one-source-of-truth] The name rule (src/daemon/home.ts): lowercase
// letters, digits and dashes, starting with a letter or digit, at most
// RENDERER_NAME_MAX characters.
func isRendererName(_ raw: String) -> Bool {
  let lowerOrDigit = { (c: Character) in c.isASCII && (c.isLowercase || c.isNumber) }
  guard let first = raw.first, lowerOrDigit(first) else { return false }
  return raw.count <= RENDERER_NAME_MAX && raw.allSatisfy { lowerOrDigit($0) || $0 == "-" }
}

// [LAW:parse-dont-validate] A link the URL handler was handed, as the socket
// file it is written to. The name is checked before it becomes any part of a
// path, because the link is whatever a web page chose to open. A link that
// names no renderer (one drawn before names) is main's, which is where every
// link went before them. The name is read raw, never decoded: the rule admits
// no character an escape spells, so an escaped name is refused.
func target(ofLink link: String) -> Target {
  guard let scheme = link.range(of: "://") else {
    return .refused("not a link: no scheme")
  }
  let rest = link[scheme.upperBound...]
  let addressed = "\(LINK_TO)/"
  guard rest.hasPrefix(addressed) else { return .file(MAIN_SOCKET_FILE) }
  let named = rest.dropFirst(addressed.count)
  let name = String(named.prefix { $0 != "/" })
  guard isRendererName(name) else {
    return .refused("the link names no renderer a home can have: \(name.debugDescription)")
  }
  return .file(name == MAIN_NAME ? MAIN_SOCKET_FILE : "\(name)\(NAMED_SOCKET_SUFFIX)")
}
