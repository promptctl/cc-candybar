// The URL handler's address rule, driven over the name rule's vectors and the
// link cases that decide which socket a click reaches. Run by test.sh, in CI's
// macOS job and `just test-url-handler`.
//
// [LAW:one-source-of-truth] NAME_ACCEPT and NAME_REJECT are the same lists as
// test/renderer-home.test.ts and the Rust client's test module, diffed by
// scripts/check-protocol.mjs: each side drives its own parser from its own list.

import Foundation

let NAME_ACCEPT = [
  "a",
  "0",
  "w1",
  "dev-bar",
  "a-",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]
let NAME_REJECT = [
  "",
  "A",
  "Dev",
  "-a",
  "a_b",
  "a.b",
  "a b",
  " a",
  "é",
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
]

@main
struct AddressTest {
  static func main() {
    var failures: [String] = []
    func expect(_ got: Target, _ want: Target, _ what: String) {
      if got != want { failures.append("\(what): got \(got), want \(want)") }
    }
    let tail = "/dispatch/does=x&e=copy%2Fhi"

    for name in NAME_ACCEPT {
      if !isRendererName(name) { failures.append("\(name.debugDescription) was refused") }
      expect(target(ofLink: "cc-candybar://to/\(name)\(tail)"), .file("\(name).sock"), "a link to \(name)")
    }
    for name in NAME_REJECT {
      if isRendererName(name) { failures.append("\(name.debugDescription) was accepted") }
      if case .file = target(ofLink: "cc-candybar://to/\(name)\(tail)") {
        failures.append("a link to \(name.debugDescription) chose a socket")
      }
    }

    expect(target(ofLink: "cc-candybar://to/main\(tail)"), .file("socket"), "a link to main")
    expect(target(ofLink: "cc-candybar://to/dev-bar\(tail)"), .file("dev-bar.sock"), "a link to a named renderer")
    // A link in a grammar older than names reaches no socket, and the refusal
    // names its form, never the link.
    expect(target(ofLink: "cc-candybar://dispatch/does=x&e=copy%2Fhi"), .refused("the link is in the direct verb form, which names no renderer"), "a direct verb")
    expect(target(ofLink: "cc-candybar://hello"), .refused("the link is in the bare copy form, which names no renderer"), "a bare copy")
    // A name is refused before it is any part of a path, and it ends at the
    // first slash, so no link reaches a file outside the directory.
    for bad in ["Dev", "..", "dev%2Dbar"] {
      if case .file(let file) = target(ofLink: "cc-candybar://to/\(bad)\(tail)") {
        failures.append("a link to \(bad.debugDescription) chose \(file)")
      }
    }
    expect(target(ofLink: "cc-candybar://to/a/../../etc"), .file("a.sock"), "a name ends at its slash")

    if failures.isEmpty {
      print("url-handler address: ok (\(NAME_ACCEPT.count + NAME_REJECT.count) names, link cases)")
      exit(0)
    }
    for failure in failures { print("FAIL \(failure)") }
    exit(1)
  }
}
