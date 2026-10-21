// seam-plan.js — resolve each declared seam to exactly one splice point in the graph, or refuse.
//
// WHY A SPLICE AND NOT A DEBUGGER. The live conversation lives on an object the graph never exports,
// so reaching it means either pausing the process on a call frame that happens to be inside that
// object's class, or having the object announce itself when it is built. The second needs no
// inspector, no breakpoint and no paused process, and it is a discrete event the host owns rather
// than a listener the session's later timing depends on. [LAW:no-ambient-temporal-coupling]
//
// WHY RESOLUTION IS EAGER AND GLOBAL. A seam is only trustworthy if it matches ONCE — in one module,
// at one offset. That is not knowable while transforming module-by-module on demand, so the whole
// graph is resolved up front, before anything is compiled. Zero matches and several matches are
// different facts from one match, and both are refusals: a seam that resolved to the wrong place is
// worse than one that did not resolve, because the first still runs. [LAW:parse-dont-validate] what
// comes back is a PROVEN plan or a typed absence, so the runtime never re-asks whether a seam landed.
//
// WHY NO MODULE NAME APPEARS IN A SEAM. Chunk names are content hashes that change every release, so
// naming one would be the version->seam table the epic exists to avoid. A seam names only a fragment
// of the app's own source, and which module carries it is an ANSWER, not an input.
//
// [LAW:effects-at-boundaries] pure throughout: sources in, plan out. No binary, no disk, no process.

'use strict';

// Every way a seam can fail to resolve, named. The launcher logs the reason it fell back to stock
// claude, so these are contract, not debug strings. [LAW:no-silent-failure]
const UNRESOLVED = {
  noModule: 'no-module-carries-the-seam',
  severalModules: 'several-modules-carry-the-seam',
  severalSites: 'seam-matches-more-than-once-in-its-module',
  absentCapture: 'seam-insert-names-a-capture-its-anchor-did-not-make',
  noBreakpointForm: 'no-seam-declares-a-breakpoint-form',
};

const unresolved = (reason, seam, detail) => ({ ok: false, reason, seam: seam.name, detail });

// Every site in `text` the seam's anchor matches: its offset, and the named groups it captured. The declared anchor is deliberately NOT global:
// a global regex carries `lastIndex` between calls, which is shared mutable state that would make
// the second scan of a module disagree with the first. [LAW:no-shared-mutable-globals]
function matchesIn(text, anchor) {
  // `g` and `y` are stripped before `g` is added: a seam declared /.../g would otherwise build
  // 'gg' and throw a SyntaxError, which escapes this module's named refusals entirely and takes the
  // host down instead of falling back to stock claude — the one outcome eager resolution exists to
  // prevent. [LAW:no-silent-failure]
  const scan = new RegExp(anchor.source, anchor.flags.replace(/[gy]/g, '') + 'g');
  const out = [];
  for (const m of text.matchAll(scan)) out.push({ index: m.index, groups: m.groups || {} });
  return out;
}

// The offsets alone.
const sitesIn = (text, anchor) => matchesIn(text, anchor).map((m) => m.index);

// A seam's code — the statement a splice inserts, or the expression a breakpoint evaluates — with each
// `$<name>` replaced by what the anchor captured there. A seam that must call into the class it
// reaches — a private method, a local the minifier named — names that piece in its anchor and refers
// to it here, so no minified name is ever written into seams.js: it is read off the release in hand.
// A reference to a group the anchor did not capture is a refusal, never code with the literal
// `$<name>` left in it, which would compile and throw at its first run. [LAW:no-silent-failure]
function fillCaptures(template, groups) {
  let missing = null;
  const text = template.replace(/\$<([A-Za-z_$][\w$]*)>/g, (ref, name) => {
    if (typeof groups[name] === 'string') return groups[name];
    missing = missing || name;
    return ref;
  });
  return missing === null ? { ok: true, text } : { ok: false, missing };
}

// Resolve one seam against the whole graph.
//   sources — name -> record, as bun-graph produces (loader + text())
//   seam    — { name, anchor, insert } from seams.js
function resolveSeam(sources, seam) {
  const carriers = [];
  for (const record of sources.values()) {
    if (record.loader !== 'js') continue;
    const sites = matchesIn(record.text(), seam.anchor);
    if (sites.length) carriers.push({ module: record.name, sites });
  }
  if (carriers.length === 0) return unresolved(UNRESOLVED.noModule, seam);
  // Naming the modules is what makes this diagnosable: "several" without which ones sends whoever
  // reads the log back to the binary to find out.
  if (carriers.length > 1) return unresolved(UNRESOLVED.severalModules, seam, carriers.map((c) => c.module).join(', '));
  const [carrier] = carriers;
  if (carrier.sites.length > 1) return unresolved(UNRESOLVED.severalSites, seam, `${carrier.module} at ${carrier.sites.map((s) => s.index).join(', ')}`);
  const [site] = carrier.sites;
  const insert = fillCaptures(seam.insert, site.groups);
  if (!insert.ok) return unresolved(UNRESOLVED.absentCapture, seam, insert.missing);
  return { ok: true, seam: seam.name, module: carrier.module, index: site.index, groups: site.groups, insert: insert.text };
}

// Where `index` falls in `text`, zero-based, as the inspector protocol counts lines and columns: lines
// end where the language says they do — CRLF, CR, LF, U+2028, U+2029 — as JSC's lexer counts them.
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/g;
function lineColumnAt(text, index) {
  let lineNumber = 0, lineStart = 0;
  for (const m of text.slice(0, index).matchAll(LINE_TERMINATOR)) { lineNumber++; lineStart = m.index + m[0].length; }
  return { lineNumber, columnNumber: index - lineStart };
}

// The breakpoint form of every seam that declares one (`attach` in seams.js), for a host that cannot
// splice — a stock Bun binary, reached over its inspector. A point is proof the seam resolved once,
// at one site, with every capture its action names: the URL the module is parsed under, the position
// the breakpoint goes, and the expression it evaluates there on every hit. Resolution is the splice
// form's own (`resolveSeam`), so the two forms cannot disagree about where a seam is.
// [LAW:one-source-of-truth] Refuses on the first seam that does not resolve, as `resolveSeams` does,
// and when no seam has a breakpoint form at all: an attach with nothing to set is a stock session
// claiming otherwise. [LAW:no-silent-failure]
function resolveBreakpoints(sources, seams) {
  const points = [];
  for (const seam of seams.filter((s) => s.attach)) {
    const site = resolveSeam(sources, seam);
    if (!site.ok) return site;
    const action = fillCaptures(seam.attach.action, site.groups);
    if (!action.ok) return unresolved(UNRESOLVED.absentCapture, seam, action.missing);
    points.push({ seam: seam.name, url: site.module, ...lineColumnAt(sources.get(site.module).text(), site.index + seam.attach.offset), action: action.text });
  }
  if (points.length === 0) return { ok: false, reason: UNRESOLVED.noBreakpointForm };
  return { ok: true, points };
}

// Resolve every seam, or refuse on the FIRST that does not. A partial plan is a plan that patches
// some of the app and not the rest, which is a state no caller has any use for.
function resolveSeams(sources, seams) {
  const sites = [];
  for (const seam of seams) {
    const site = resolveSeam(sources, seam);
    if (!site.ok) return site;
    sites.push(site);
  }
  const splices = new Map();
  for (const site of sites) {
    const forModule = splices.get(site.module) || [];
    forModule.push({ index: site.index, insert: site.insert });
    splices.set(site.module, forModule);
  }
  return { ok: true, sites, splices };
}

// Apply one module's insertions. HIGHEST OFFSET FIRST, so each splice leaves every offset below it
// where the plan measured it. Front-to-back would shift every later index by the length of every
// earlier insertion, which is a plan that is right about the first seam and wrong about the rest.
function spliceSource(text, inserts) {
  const ordered = [...inserts].sort((a, b) => b.index - a.index);
  let out = text;
  for (const { index, insert } of ordered) out = out.slice(0, index) + insert + out.slice(index);
  return out;
}

// The plan's own knowledge of how it is consumed: the one function bun-runtime applies in moduleFor.
// Modules with no seam come back byte-identical, so the recovered source still runs verbatim
// everywhere the plan does not reach. [LAW:dataflow-not-control-flow] every module goes through the
// same call; whether anything changes is decided by the plan's data, not by a branch at the callsite.
function transformFor(plan) {
  return (name, text) => {
    const inserts = plan.splices.get(name);
    return inserts ? spliceSource(text, inserts) : text;
  };
}

module.exports = { UNRESOLVED, sitesIn, lineColumnAt, resolveSeam, resolveSeams, resolveBreakpoints, spliceSource, transformFor };
