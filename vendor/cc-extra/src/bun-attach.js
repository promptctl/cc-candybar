#!/usr/bin/env node
// bun-attach.js — run the shipped claude binary under Bun, exactly as shipped, and apply every seam
// that has a breakpoint form through the inspector Bun opens for it.
//
// WHY THIS EXISTS BESIDE launch.js. The hosted session (launch.js -> bun-host.mjs) splices the app's
// source as node links it, which reaches every seam but replaces Bun with a surface assembled here.
// This launcher keeps Bun and the binary untouched and reaches the app the one way a stock Bun process
// can be reached: JavaScriptCore's inspector, over a unix socket, with breakpoints that evaluate a
// seam's action in the frame they stop in and carry on without pausing. It reaches only the seams
// whose effect a breakpoint can produce (`attach` in seams.js); a gate that must RETURN something else,
// like propose-goal, needs the splice.
//
// WHY THE DEBUGGER ATTACHES AT ENTRY. JSC gives debug hooks only to code compiled while a debugger is
// attached, and Bun does not recompile on attach: a breakpoint set in a session that booted without
// one resolves and never fires (MEASURED on 2.1.299, three app functions called through breakpoints,
// zero pauses). So the binary is started held at entry (`?wait=1`), the debugger is enabled, the
// registrar is installed and the breakpoints are set — all before a line of the app has run — and
// only then is it released. The breakpoints are set BY URL before their chunk exists; JSC binds each
// one as its chunk parses (MEASURED: `breakpointResolved` at the predicted line and column).
// [LAW:no-ambient-temporal-coupling] the order is this sequence's, and two waits in it are on a clock,
// each with one owner: the socket's appearance, which has a deadline, and the question asked of the
// released process (WHY IT STAYS CONNECTED), which is asked again and again until it is a TUI or
// ASK_WITHIN_MS has passed.
//
// WHY A UNIX SOCKET. The inspector runs arbitrary code in the session. On TCP it is reachable by every
// process on the machine; a socket in a directory only this user can enter is reachable by this user.
//
// WHY IT STAYS CONNECTED. A breakpoint fires only while a client is connected: disconnect, and the
// status line's breakpoint stopped firing (MEASURED on 2.1.299: 2 hits before, still 2 after six status
// line reruns; connected, 2 became 8). What outlives a disconnect is only the wrapper an earlier hit
// installed, on the one controller that hit reached — a controller the app builds later would never be
// wrapped (MEASURED: a live session wrapped a second controller 18s in). So for a TUI the launcher stays
// connected for the life of the session, and a connected debugger does not keep it from exiting
// (MEASURED: `/exit` ended it, exit 0). The run it lets go is a one-shot: the inspector holds a process
// that ends by draining its loop (`--version`) for as long as it is connected, and that process gives
// no sign it is done (MEASURED: `beforeExit` never fires while it is held). Which of the two a run is,
// the process is ASKED, every ASK_EVERY_MS after release: a TUI puts stdin in raw mode as it mounts,
// and the first answer that it has is the verdict.
//
// FAILURE. Every step before release happens while the binary is held at entry, where nothing the user
// asked for has run, so a failure there is answered by killing the held process and exiting non-zero,
// with one line on stderr saying why — before any TUI exists to draw over it. Never with a stock
// session: one would look like the attached session that failed, so whoever asked for the attach could
// not tell it never happened. [LAW:no-silent-failure] After release
// the session is the user's: nothing this launcher sees is a reason to end it, and what goes wrong is
// written to the log and named on stderr once the session is over. [LAW:no-silent-failure]

'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readGraphFromFile } = require('./bun-graph.js');
const { SEAMS, REGISTRAR } = require('./seams.js');
const { resolveBreakpoints } = require('./seam-plan.js');
const { registrarSource } = require('./attach-registrar.js');
const { connect } = require('./ws-unix.js');
const { createInspectorSession } = require('./inspector-session.js');
const { superviseSignals, hasControllingTerminal, attachedToTerminal, rendersTui, exitStatus } = require('./launch.js');

// Measured ~20ms from spawn to the socket on 2.1.299. Generous, because missing it costs the
// session and waiting costs only a slower start.
const SOCKET_DEADLINE_MS = 5000;

// Whether a TUI is up. A TUI puts stdin in raw mode as it mounts — a trust dialog before the prompt
// included — and a one-shot never does (MEASURED on 2.1.299: raw 127-131ms after release, every run;
// `--version` not raw, exiting as soon as it was let go — the asking does not hold it).
const TUI_IS_UP = 'process.stdin.isTTY === true && process.stdin.isRaw === true';

// How often after release the process is asked TUI_IS_UP, and for how long. A TUI is attached the
// moment it answers raw, so the deadline is paid only by a run that never does — an interactive
// one-shot like `--version`, held that long before it is let go. Asking once, at 2s, took a TUI that
// mounted later for a one-shot: `--resume` restarts on 2.1.289 reached raw mode 2.0-3.3s after release,
// and 2 of 11 ran without the push. A real session (more plugins, a longer transcript) mounts slower
// still, so the deadline is three times the slowest measured mount. A TUI slower than that is taken for
// a one-shot and runs without the push; the log says which, and when the answer came.
const ASK_EVERY_MS = 100;
const ASK_WITHIN_MS = 10000;
const SOCKET_NAME = 'inspector.sock';

// Per user, never the shared temp dir: on Linux that is /tmp, where another user could plant the log
// name first, as a file to read the session's lines from or a link to append them through.
const LOG_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'cc-extra');
const LOG_PATH = path.join(LOG_DIR, 'attach.log');

// What the binary is started with: its inspector on the socket, holding at entry until released.
const inspectedEnv = (env, socketPath) => ({ ...env, BUN_INSPECT: `ws+unix://${socketPath}?wait=1` });

// The inspector calls that make a held process an attached one, in the order they must run: the
// debugger is enabled before any app code compiles, the registrar exists before any breakpoint can
// call it, and release comes last. BUN_INSPECT is taken out of the process's environment before a
// line of the app runs: every Bun process the session starts — the Bash tool's `bun`, a hook, a nested
// claude — would inherit it and fail to start its own inspector on the socket this one holds
// (MEASURED: `Failed to start inspector`, exit 1; deleted at entry, the same child ran clean). Each breakpoint's action is a PROBE, which evaluates it as an
// evaluate action would and also sends the result back, so the launcher sees each hit's answer —
// including a throw, which an evaluate action would swallow. [LAW:no-silent-failure]
// [LAW:effects-at-boundaries] a description, so the suite checks the order with no process.
function attachCalls(points, registrarExpression) {
  return [
    ['Debugger.enable', {}],
    // JSC's debugger starts with breakpoints deactivated; its own frontend activates them on connect.
    ['Debugger.setBreakpointsActive', { active: true }],
    ['Runtime.evaluate', { expression: 'delete process.env.BUN_INSPECT', returnByValue: true }],
    ['Runtime.evaluate', { expression: registrarExpression, returnByValue: true }],
    ...points.map((p, i) => ['Debugger.setBreakpointByUrl', {
      url: p.url, lineNumber: p.lineNumber, columnNumber: p.columnNumber,
      options: { autoContinue: true, actions: [{ id: i + 1, type: 'probe', data: p.action }] },
    }]),
    ['Inspector.initialized', {}],
  ];
}

// What one probe sample means: the registrar's answer ('attached' the first time a controller is
// reached, 'held' after), or a failure naming what came back instead.
function readSample(payload) {
  if (payload.type === 'string' && (payload.value === 'attached' || payload.value === 'held')) return { ok: true, value: payload.value };
  return { ok: false, detail: payload.description || JSON.stringify(payload.value) };
}

// How often the wait looks for the socket. A look is one stat; the socket appears ~20ms after spawn.
const SOCKET_LOOK_MS = 10;

// Resolves once `name` exists in `dir`, rejects at the deadline or when `exited` settles first. It
// LOOKS on a clock rather than watching the directory: on macOS fs.watch does not report every bind
// of a unix socket (MEASURED on 2.1.289: 18 of 20 binds unseen, the socket there when the deadline
// fired), and a missed one cost the attach. [LAW:no-ambient-temporal-coupling] the clock has one
// owner, this wait, and one end, the deadline.
function socketAppears(dir, name, deadlineMs, exited) {
  return new Promise((resolve, reject) => {
    const done = (settle) => { clearTimeout(timer); clearInterval(looking); settle(); };
    const check = () => { if (fs.existsSync(path.join(dir, name))) done(resolve); };
    const timer = setTimeout(() => done(() => reject(new Error(`no inspector socket within ${deadlineMs}ms`))), deadlineMs);
    const looking = setInterval(check, SOCKET_LOOK_MS);
    exited.then((ending) => done(() => reject(new Error(`claude ${describeEnding(ending)} before opening its inspector`))));
    check();
  });
}

const describeEnding = ({ code, signal, error }) => (error ? `could not start: ${error}` : `exited ${signal || code}`);

// What the released run is, asked of it every `everyMs` after release, one question in flight at a
// time: `{ runs: 'tui' }` at the first answer that stdin is raw, `{ runs: 'one-shot' }` at the first
// answer that it is not once `withinMs` has passed, `{ runs: 'closed' }` when the inspector went away
// first (the run ended, or the connection did), or `{ runs: 'unanswered', why }` when a question itself
// failed. A close resolves before the rejection it causes reaches here, so a rejection that does is the
// question failing. [LAW:no-ambient-temporal-coupling] the verdict waits on the fact it is about, and
// the deadline only bounds that wait; it never decides while an answer could still say otherwise.
// `session` is anything with the session's `send` and `on`; `delay(ms, fn)` is a cancellable timer. A
// pure seam, so the suite drives it with neither an inspector nor a clock. [LAW:effects-at-boundaries]
function askWhatRuns(session, { everyMs, withinMs }, delay) {
  return new Promise((resolve) => {
    let settled = false;
    let expired = false;
    let cancelNext = () => {};
    const cancelDeadline = delay(withinMs, () => { expired = true; });
    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      cancelNext();
      cancelDeadline();
      resolve(verdict);
    };
    const answered = (r) => {
      if (r.wasThrown) return settle({ runs: 'unanswered', why: r.result.description ?? JSON.stringify(r.result.value) });
      if (r.result.value === true) return settle({ runs: 'tui' });
      if (expired) return settle({ runs: 'one-shot' });
      if (!settled) cancelNext = delay(everyMs, ask);
    };
    const ask = () => session.send('Runtime.evaluate', { expression: TUI_IS_UP, returnByValue: true })
      .then(answered, (e) => settle({ runs: 'unanswered', why: e.message }));
    cancelNext = delay(everyMs, ask);
    session.on('close', () => settle({ runs: 'closed' }));
  });
}

// Run `binary` with the user's terminal and signals, resolving to how it ended: `{ code, signal }`, or
// `{ code: 70, signal: null, error }` when it could not be started at all. `interrupted()` says whether
// the user signalled an end to the session, as launch.js's verdict reads it.
function runChild(binary, args, env) {
  const child = childProcess.spawn(binary, args, { stdio: 'inherit', env });
  let interrupted = false;
  const stopSupervising = superviseSignals(child, {
    sharesTerminalGroup: hasControllingTerminal(),
    onSignal: () => { interrupted = true; },
    on: (signal, handler) => process.on(signal, handler),
    off: (signal, handler) => process.off(signal, handler),
  });
  const exited = new Promise((resolve) => {
    child.on('error', (e) => resolve({ code: 70, signal: null, error: e.message }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  }).then((ending) => { stopSupervising(); return ending; });
  return { child, exited, interrupted: () => interrupted };
}

// An attach that cannot happen: said, and nothing started in its place.
function refuse(why, { stderr }) {
  stderr(`cc-extra: not attached — ${why}; claude was not started (log: ${LOG_PATH})`);
  return 1;
}

async function runStock(binary, args, why, { stderr }) {
  stderr(`cc-extra: not attaching — ${why}; running stock claude`);
  const { exited } = runChild(binary, args, process.env);
  const ending = await exited;
  if (ending.error) stderr(`cc-extra: claude ${describeEnding(ending)}`);
  return exitStatus(ending.code, ending.signal);
}

async function attachAndRun(binary, args, io = {}) {
  const stderr = io.stderr || ((line) => process.stderr.write(line + '\n'));
  // [LAW:no-silent-failure] a line the log cannot take is counted and named when the session ends, and
  // never changes what the launcher does: thrown, it could leave a held binary held.
  let unlogged = 0;
  const log = (line) => {
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
      fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${process.pid} launcher: ${line}\n`);
    } catch { unlogged++; }
  };

  // Only a TUI has a status line to drive. A headless, piped or print-mode run (`-p`, at a terminal or
  // not) is a one-shot that would pay the wait below for nothing and wants to stay exactly as fast as
  // it shipped. [LAW:one-source-of-truth] whether a run renders a TUI is launch.js's one parse of it; an
  // interactive `--version` still reads as a TUI there, and is let go at ASK_WITHIN_MS.
  if (!rendersTui(args, io.terminal ?? attachedToTerminal())) return runStock(binary, args, 'not a TUI: no status line to drive', { stderr });

  const graph = readGraphFromFile(binary);
  const plan = graph.ok ? resolveBreakpoints(new Map(graph.modules.map((m) => [m.name, m])), SEAMS) : graph;
  if (!plan.ok) return refuse(`${plan.reason}${plan.seam ? ` (seam ${plan.seam})` : ''}${plan.detail ? `: ${plan.detail}` : ''}`, { stderr });

  // Before the spawn, so the log's directory exists for the registrar's first line.
  log(`attaching ${binary}`);
  // mkdtemp makes the directory 0700: only this user can reach the socket inside it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-extra-attach-'));
  const socketPath = path.join(dir, SOCKET_NAME);
  const calls = attachCalls(plan.points, registrarSource({ registrar: REGISTRAR, logPath: LOG_PATH }));
  const release = calls.at(-1);
  const { child, exited, interrupted } = runChild(binary, args, inspectedEnv(process.env, socketPath));

  // What went wrong after release, said once the session is over rather than over the TUI. A set: a
  // failure that repeats on every status line run is one trouble, not one per second of the session.
  const troubles = new Set();
  const bound = new Set();
  let session;
  try {
    await socketAppears(dir, SOCKET_NAME, SOCKET_DEADLINE_MS, exited);
    session = createInspectorSession(await connect(socketPath));
    const seamOf = new Map(plan.points.map((p, i) => [i + 1, p.seam]));
    session.on('Debugger.breakpointResolved', ({ breakpointId, location }) => {
      bound.add(breakpointId);
      log(`breakpoint ${breakpointId} bound at ${location.lineNumber}:${location.columnNumber}`);
    });
    session.on('Debugger.didSampleProbe', ({ sample }) => {
      const read = readSample(sample.payload);
      if (read.ok && read.value === 'held') return;
      const line = read.ok ? `${seamOf.get(sample.probeId)}: ${read.value}` : `${seamOf.get(sample.probeId)} failed in the session: ${read.detail}`;
      if (read.ok) { log(line); return; }
      if (!troubles.has(line)) log(line);
      troubles.add(line);
    });
    session.on('fault', (why) => { troubles.add(`the inspector session broke, so the seams stopped: ${why}`); });
    session.on('close', (why) => { log(`inspector closed: ${why}`); });
    for (const [method, params] of calls.slice(0, -1)) {
      const result = await session.send(method, params);
      if (result && result.wasThrown) throw new Error(`${method} threw: ${result.result.description ?? JSON.stringify(result.result.value)}`);
    }
  } catch (e) {
    // Still held at entry: nothing the user asked for has run, so replacing it repeats nothing — unless
    // the user is what ended it. A Ctrl+C while held kills the child and fails the attach with it, and
    // answering that with a stock session starts the one the user just stopped.
    if (session) session.close();
    child.kill('SIGKILL');
    log(`attach failed: ${e.message}`);
    const ending = await exited;
    fs.rmSync(dir, { recursive: true, force: true });
    if (interrupted()) return exitStatus(ending.code, ending.signal);
    return refuse(`attach failed: ${e.message}`, { stderr });
  }

  // Release. A failure here leaves the process's state unknown — it may already be running the user's
  // command — so it is never answered with a second session; it is reported when this one ends.
  await session.send(...release).catch((e) => troubles.add(`release failed: ${e.message}`));
  log(`released ${binary} with ${plan.points.map((p) => p.seam).join(', ')}`);

  // Only a run that answered 'tui' keeps the launcher connected for the session (see WHY IT STAYS
  // CONNECTED). Anything else is let go, because staying is what holds a one-shot, and a question that
  // could not be answered is said why.
  const releasedAt = Date.now();
  const { runs, why } = await askWhatRuns(session, { everyMs: ASK_EVERY_MS, withinMs: ASK_WITHIN_MS }, (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); });
  log(`after release: ${runs} at ${Date.now() - releasedAt}ms${why ? ` (${why})` : ''}`);
  if (runs !== 'tui') session.close();
  if (runs === 'unanswered') troubles.add(`could not ask the session whether it is a TUI, so it ran without the push: ${why}`);

  const { code, signal } = await exited;
  // Our end of the connection is ours to close, rather than waiting on the peer's to.
  session.close();
  // A breakpoint set by a URL the release no longer parses its chunk under binds nowhere, and nothing
  // else would say so: the push is simply absent.
  if (runs === 'tui' && bound.size < plan.points.length) troubles.add(`${plan.points.length - bound.size} of ${plan.points.length} breakpoint(s) never bound in this session, so their seams never ran`);
  fs.rmSync(dir, { recursive: true, force: true });
  if (unlogged) troubles.add(`${unlogged} line(s) could not be written to the log`);
  for (const line of troubles) stderr(`cc-extra: ${line} (log: ${LOG_PATH})`);
  return exitStatus(code, signal);
}

module.exports = { SOCKET_DEADLINE_MS, ASK_EVERY_MS, ASK_WITHIN_MS, TUI_IS_UP, LOG_PATH, inspectedEnv, attachCalls, readSample, socketAppears, askWhatRuns, attachAndRun };

if (require.main === module) (async function main() {
  const [binary, ...args] = process.argv.slice(2);
  if (!binary) {
    process.stderr.write('usage: bun-attach.js <installed-claude-binary> [claude args...]\n');
    process.exit(2);
  }
  process.exitCode = await attachAndRun(binary, args);
})();
