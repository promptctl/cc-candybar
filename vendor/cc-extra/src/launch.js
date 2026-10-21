#!/usr/bin/env node
// launch.js — start a Claude Code session, hosted if the graph can be hosted and stock if it cannot.
//
// A user who opts into the hosted session must never end up with a broken one. So this launcher does
// not decide between two code paths; it runs a LIST OF PLANS in order and keeps the first that boots.
// Every plan is the same operation — spawn this argv, watch the boot channel — and they differ only
// in their data, which is what keeps the fail-safe from being a special case that skips setup.
// [LAW:dataflow-not-control-flow] Adding a plan is adding a value.
//
// The last plan is stock `claude`, which is declared booted the moment it starts: it is the floor,
// not a candidate, and there is nothing after it to fall back to.
//
// WHY THE VERDICT IS FORMED HERE. bun-host.mjs reports only what it can see — `painted` the first
// time the hosted graph writes to the terminal, or a named refusal — and never decides. The failures
// this guards against are not visible from inside: a HANG, where a boot-critical Bun API returns
// undefined and the first render throws a TypeError the app swallows, so nothing further happens at
// all; and its louder cousin, where the app prints a notice and then dies on that same TypeError.
// Neither is distinguishable from inside the host — one needs a clock and the other needs to watch
// the process afterwards — so both belong to whoever can act on them.
// [LAW:no-ambient-temporal-coupling] one owner for the timing, named here.
//
// Once a plan has become the session it OWNS it: a later crash is that session's business, and is
// never answered by starting a second session on top of whatever the first one already did.

'use strict';

const childProcess = require('child_process');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { readReport, RECORD_SEPARATOR, BOOT_FD_ENV } = require('./boot-channel.js');
const { constants: { signals: SIGNAL_NUMBERS } } = require('os');

// Measured on 2.1.258: ~800ms to link 1,640 modules and ~700ms more to the first frame. The deadline
// is an order of magnitude of headroom over that, because the cost of waiting too long is a slow
// start and the cost of waiting too little is falling back on a session that was about to work.
const BOOT_DEADLINE_MS = 15000;

// How long a plan must survive its first paint before it counts as the session. Long enough that the
// app's own fatal-error path (which prints, then exits) lands inside it, short enough to be invisible.
const BOOT_SETTLE_MS = 5000;

const BOOT_FD = 3;
const HOST = path.join(__dirname, 'bun-host.mjs');

// Sent before the next plan takes the terminal, never after a boot. The escape sequence puts the
// screen back; raw mode is not a screen state and has to be cleared through the tty itself, which
// `resetTerminal` below does — the sequence alone would leave the keyboard in the dead plan's mode.
const TERMINAL_RESET = '\u001b[?1049l\u001b[?25h\u001b[?2004l\u001b[0m';

// Put the terminal back the way a plan that died mid-render did not. Raw mode is the half an escape
// sequence cannot reach: a dead child's stdin mode outlives it, and the next plan would inherit a
// keyboard that echoes nothing.
function resetTerminal() {
  if (!process.stdout.isTTY) return;
  process.stdout.write(TERMINAL_RESET);
  if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
}

// A TUI needs BOTH ends: a keyboard to read and a screen to draw on.
const attachedToTerminal = (streams = process) => Boolean(streams.stdin.isTTY && streams.stdout.isTTY);

// Whether the kernel will deliver a terminal's signals to this process's whole group — which is what
// decides, below, whether the child already has its own copy. What this actually tests is narrower
// than that question: whether ANY of the three standard descriptors still points at a tty. Keying on
// stdin alone answered "no terminal" for `claude -p "..." < prompt.txt`, which is still in the
// foreground group, so the launcher forwarded a SIGINT the kernel had already delivered — and
// widening it to all three is what closed that case.
//
// [LAW:single-enforcer] exception: the real question is "does this process's group own the terminal",
// and node exposes no `tcgetpgrp` to ask it — nor, underneath, any way to tell a SIGINT the terminal
// raised for the whole group from one addressed to this pid alone, which would need the sender from
// `siginfo` that node never surfaces. So this boundary approximates, and two gaps stay open:
//   - all three descriptors redirected while still in the foreground group (`claude -p "..." < in
//     > out 2> err`) reads as "no terminal" and forwards a second SIGINT. No tty means no TUI, and
//     print mode is already dying of the first one, so the duplicate lands on a process on its way
//     out rather than becoming the second press that quits a session.
//   - a backgrounded job keeps its descriptors on the tty and reads as "shared", so nothing is
//     forwarded, while the kernel delivers terminal signals only to the foreground group. The
//     shell's own `kill -INT %1` addresses the job's process GROUP, which contains the child, so it
//     still arrives; only a signal aimed at this launcher's pid alone is lost.
// It errs toward holding on purpose. A duplicate Ctrl+C inside a TUI is the two presses that make
// Claude Code exit — visible and unrecoverable — where a signal not forwarded leaves the child
// running and the user free to press again.
const hasControllingTerminal = (streams = process) =>
  Boolean(streams.stdin.isTTY || streams.stdout.isTTY || streams.stderr.isTTY);

// What makes an invocation something other than a TUI. Print mode renders no frame and
// can legitimately think for minutes before its first byte of stdout, which is exactly the silence
// the deadline below reads as a hang. Nearly every other one-shot — a version, a help — prints within
// moments and exits 0, and an exit of 0 is already a finished command to the verdict, so print mode
// earns a table of one rather than a list of subcommands to chase.
// `claude mcp serve` is the known exception: a stdio server that paints nothing and stays up until a
// client speaks. Typed at a terminal it is read as a TUI owing a first frame, and the deadline kills
// it — into the fallback, which runs the same command under stock claude and works. Its ordinary
// invocation is a client handing it a pipe, where there is no tty and `tui` is already false. A row
// for it would buy a mode [LAW:no-mode-explosion] to save a restart the fail-safe already covers.
// The short flags the CLI declares as plain booleans, which is what decides how far a CLUSTER is
// read. Commander splits `-cp` into `-c -p`, so it is a real print-mode invocation, while `-d`,
// `-n`, `-r` and `-w` each take a value and swallow the rest of their cluster — the `p` in `-np` is
// the session NAME "p" and not print at all, and reading it as print would retire the hang check for
// a run that really does render a TUI. Measured against 2.1.280: `claude -cx` answers
// `unknown option '-x'` (the cluster was split), where `claude -nx` takes `x` as the name and
// `claude -zp` answers `unknown option '-zp'` (an unknown first letter is never split).
// [LAW:one-source-of-truth] this mirrors a grammar this repo does not own, so it stops at the first
// letter it does not recognise rather than guessing past it.
const BOOLEAN_SHORT_FLAGS = new Set(['c', 'h', 'p', 'v']);

// Does this one argument ask for print mode? A whole-argument comparison answers no for `-cp`, and
// that gap is the double execution below arriving by a spelling: the run is print mode, is judged a
// TUI, owes a first frame it will never paint, and is killed at the deadline for the floor to run
// again.
const requestsPrint = (arg) => {
  if (arg === '--print') return true;
  if (arg.startsWith('--') || !arg.startsWith('-') || arg === '-') return false;
  for (const letter of arg.slice(1)) {
    if (letter === 'p') return true;
    if (!BOOLEAN_SHORT_FLAGS.has(letter)) return false;
  }
  return false;
};

// Does this invocation render a TUI? Two questions in this launcher turn on the answer, and both
// used to be answered with "is stdout a terminal" — the same answer for `claude` and for
// `claude -p "commit this"` typed at the same prompt. It is the wrong answer for the second: print
// mode owes no first frame, so the deadline killed it at 15s and the floor then ran the prompt a
// SECOND time, repeating every edit and commit the killed run had already made.
// [LAW:one-source-of-truth] one fact about the invocation, parsed once, read in both places.
const rendersTui = (userArgs, hasTerminal) => {
  // Everything after a bare `--` is positional, so a `-p` standing there is the user's own text.
  const positional = userArgs.indexOf('--');
  const flags = positional === -1 ? userArgs : userArgs.slice(0, positional);
  return hasTerminal && !flags.some(requestsPrint);
};

// Signals the terminal generates are delivered by the kernel to the whole foreground process group,
// and the child is in this launcher's group: it already has its own copy. Forwarding a second one
// would make a single Ctrl+C read as the two presses that make Claude Code exit. A signal addressed
// to this process alone never reached the child, and passing it on is the only way it hears.
// [LAW:single-enforcer] the kernel delivers where it delivers; the launcher delivers only where it
// does not.
const TERMINAL_SIGNALS = ['SIGINT', 'SIGQUIT', 'SIGHUP'];
const ADDRESSED_SIGNALS = ['SIGTERM'];
const SUPERVISED_SIGNALS = [...TERMINAL_SIGNALS, ...ADDRESSED_SIGNALS];

// Stand between the signal and the child for as long as the child is the session. Without this the
// launcher took node's default disposition and simply died on the first Ctrl+C, leaving the session
// running on a terminal the shell had already taken back — a live TUI drawing into a fresh prompt,
// and a wrapper exit code that was the launcher's death rather than the session's.
//
// `onSignal` is told about every supervised signal whether or not it was forwarded, because the fact
// the verdict needs is that the USER ended this session, not which process delivered the signal.
// [LAW:dataflow-not-control-flow] holding and forwarding are one operation over a different list of
// recipients, never two code paths.
function superviseSignals(child, { sharesTerminalGroup, onSignal, on, off }) {
  const recipients = (signal) => (sharesTerminalGroup && TERMINAL_SIGNALS.includes(signal) ? [] : [child]);
  const installed = SUPERVISED_SIGNALS.map((signal) => [signal, () => {
    onSignal(signal);
    for (const target of recipients(signal)) target.kill(signal);
  }]);
  for (const [signal, handler] of installed) on(signal, handler);
  // The undo, because the next plan gets its own child: a handler still aimed at the dead one would
  // swallow the user's Ctrl+C into nothing.
  return () => { for (const [signal, handler] of installed) off(signal, handler); };
}

// A child's ending as this wrapper's exit code: its own code, or the conventional encoding for "killed
// by a signal", so a SIGKILL and a SIGTERM stay distinguishable to whatever reads it.
const exitStatus = (code, signal) => (code === null ? 128 + (SIGNAL_NUMBERS[signal] ?? 0) : code);

// The plans, in order. `reports` says whether a plan speaks on the boot channel: the hosted one does,
// and stock claude is the floor — it is the session by definition and there is nothing after it.
function plans(binaryPath, userArgs) {
  return [
    {
      name: 'hosted',
      command: process.execPath,
      // --experimental-vm-modules: the host links Bun's module graph itself (bun-host.mjs explains
      // why node's own loader cannot). The warning is silenced because this process shares the
      // user's terminal with a TUI.
      args: ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', HOST, binaryPath, ...userArgs],
      env: { ...process.env, [BOOT_FD_ENV]: String(BOOT_FD) },
      reports: true,
    },
    {
      name: 'stock',
      command: binaryPath,
      args: userArgs,
      env: process.env,
      reports: false,
    },
  ];
}

// Run one plan to a verdict. Resolves { booted: true, code } once the plan became the session and
// that session has finished, or { booted: false, reason } if it never became one.
//
// A plan that reports a NAMED refusal without painting never reached the user's command, so it is
// always replaced. Past that, a plan became the session when it painted the terminal AND was still
// there a moment later. Painting alone is not enough — a boot-critical API that returns undefined lets the app print a notice and
// then die on the TypeError, which reads as output but is not a session. Two exits are booted
// whatever else happened, and neither may ever be re-run: a clean exit, which is what a one-shot
// command does (silently, if all its output went to stderr), and any exit at all from an invocation
// that renders no TUI, where the run may already have done real work.
//
// The child is given the real terminal on stdio 0-2 — a pipe would make isTTY false and there would
// be no TUI to check — so its reports travel on a descriptor of their own.
function run(plan, {
  deadlineMs = BOOT_DEADLINE_MS,
  settleMs = BOOT_SETTLE_MS,
  tui,
  spawn = childProcess.spawn,
  signals = process,
  sharesTerminalGroup = hasControllingTerminal(),
} = {}) {
  // Whether this invocation renders a TUI is the INVOCATION's fact, parsed once by the caller and
  // handed down. There is no defensible default for it here: guessing false retires the hang check,
  // and guessing true kills one-shots that were working. [LAW:no-silent-failure]
  if (typeof tui !== 'boolean') throw new TypeError('run needs tui: whether this invocation renders a TUI');
  return new Promise((resolve) => {
    // The array index IS the descriptor number, so BOOT_FD owns its own position instead of being a
    // name for a 3 that is also written out positionally beside it. [LAW:one-source-of-truth]
    const stdio = Array.from({ length: BOOT_FD + 1 }, (_, fd) => (fd < 3 ? 'inherit' : 'ignore'));
    stdio[BOOT_FD] = plan.reports ? 'pipe' : 'ignore';
    const child = spawn(plan.command, plan.args, { stdio, env: plan.env });

    // Which signal the user ended this session with, if any. Tracked because a session the user
    // stopped is not a plan that failed to start, and the difference is invisible from the exit
    // status alone: both arrive as "killed by SIGINT before painting".
    let interrupted = null;
    const stopSupervising = superviseSignals(child, {
      sharesTerminalGroup,
      onSignal: (signal) => { interrupted = interrupted || signal; },
      on: (signal, handler) => signals.on(signal, handler),
      off: (signal, handler) => signals.off(signal, handler),
    });

    let paintedAt = 0;
    // Whether the hosted graph ever handed control to the app. Reported, not inferred: before it,
    // nothing the user asked for has run and a failure is always safe to replace; after it, the app
    // owns whatever it did and re-running would repeat it.
    let started = !plan.reports;
    let refusal = '';
    const absentApis = [];
    let timer = null;
    // The verdict needs both halves: how the process ended, and everything it reported. 'exit' fires
    // when the OS reaps the child, which can be BEFORE the last chunk buffered on the boot channel
    // has been delivered — so a plan that paints and immediately exits would read as never having
    // painted, and get re-run. [LAW:no-ambient-temporal-coupling] the verdict waits on both facts
    // rather than on which event happened to land first.
    let ended = null;
    let channelDone = !plan.reports;
    // Set when the deadline fired. The plan is killed then, but the verdict is not delivered until
    // the process is actually gone: handing the terminal to the next plan while the old one still
    // holds it is two sessions writing to one screen.
    let deadlineReason = null;
    const settle = () => {
      if (!ended || !channelDone) return;
      clearTimeout(timer);
      stopSupervising();
      resolve(verdict(ended));
    };

    // Whatever went wrong, say which Bun APIs this shim did not have. On a hang that list is the
    // whole diagnosis, and it is the one thing the killed host can no longer tell anyone itself.
    const because = (reason) => reason + (absentApis.length ? ` (Bun APIs the shim does not have: ${absentApis.join(', ')})` : '');

    // How an ended plan is judged. The floor has no successor, so there is no decision to make: it
    // IS the session, whatever it did. Every rule after it answers one question — should the next
    // plan be tried instead? — and the exits that are never re-tried come FIRST, because they are
    // the ones where re-trying would repeat work the user already got: a clean exit is a one-shot
    // command finishing (silently, if all its output went to stderr), and where no TUI was ever
    // rendered there is no session to salvage, only a command that already ran.
    const verdict = ({ code, signal, at }) => {
      const exit = exitStatus(code, signal);
      if (!plan.reports) return { booted: true, code: exit };
      // The user ending this session is not a plan failing to start, and it comes first because
      // every rule below it asks whether to try the next plan instead — a question a Ctrl+C has
      // already answered. Without this, the interrupt that cancelled a hosted boot would be met by
      // starting a stock session on top of the one the user had just stopped.
      if (interrupted) return { booted: true, code: exit };
      // The deadline fired and this plan was killed for it. It is a rule among the others rather
      // than an exit formed above them, because an exit formed outside `verdict` cannot be outranked
      // by anything written inside it — and the interrupt above is exactly the rule that has to
      // outrank it. A user who gave up on a hang and pressed Ctrl+C was answered by a whole new
      // stock session ten seconds later, started on top of the one they had just stopped.
      // [LAW:single-enforcer] one place forms the verdict, so the order written here is the order
      // that runs.
      if (deadlineReason) return { booted: false, reason: deadlineReason };
      // The app never ran, so there is nothing to preserve and nothing to weigh — replace it,
      // terminal or no terminal. Inferring this from "did stdout see a byte" is what let a host that
      // crashed before it could report anything be treated as a finished command in a pipe.
      if (!started) return { booted: false, reason: because(refusal || `exited ${signal || code} before the app started`) };
      // Past `started` and outside a TUI the command RAN, and what it printed, edited or committed
      // is done. It comes before the refusal rule because a refusal names how a run ended, never
      // whether the app owned work — and `paintedAt` answers that question only by inference from
      // what stdout happened to see, which is the inference `started` was reported to replace.
      // Below the refusal rule, print mode's silent tool-using run (nothing on stdout until the
      // answer) was re-run, repeating every edit and commit — the exact double execution `rendersTui`
      // exists to prevent, reintroduced by the ORDER rather than by the parse.
      // [LAW:one-source-of-truth] one fact about whether the app owned work, reported once.
      if (!tui) return { booted: true, code: exit };
      // A TUI that started, refused, and never drew a frame: nothing was ever put in front of the
      // user, so the named refusal is the better answer than the exit status. It earns its place
      // above the clean exit for the one case that rule would otherwise pass as success — a host
      // that refuses and still manages to exit 0, which switched the fail-safe off silently.
      if (refusal && !paintedAt) return { booted: false, reason: because(refusal) };
      if (exit === 0) return { booted: true, code: exit };
      if (!paintedAt) return { booted: false, reason: because(`exited ${signal || code} before painting anything`) };
      // Clamped: a paint report can arrive AFTER the exit, because the pipe outlives the process.
      // The paint really did happen first, so the honest reading of that ordering is a session that
      // lasted no time at all — not a negative one.
      const lived = Math.max(0, at - paintedAt);
      if (lived >= settleMs) return { booted: true, code: exit };
      const died = refusal ? `: ${refusal}` : '';
      return { booted: false, reason: because(`painted, then exited ${exit} after ${lived}ms — never became a session${died}`) };
    };

    if (plan.reports) {
      timer = setTimeout(() => {
        // The reason is fixed HERE, before the kill, so the exit it causes cannot answer for the
        // deadline that caused it. [LAW:no-ambient-temporal-coupling]
        deadlineReason = because(`nothing painted within ${deadlineMs}ms`);
        child.kill('SIGKILL');
      }, deadlineMs);
      const channel = child.stdio[BOOT_FD];
      // Decoded across chunk boundaries: a multi-byte character split between two reads would
      // otherwise become two replacement characters.
      const decoder = new StringDecoder('utf8');
      let pending = '';
      const consume = (text) => {
        pending += text;
        const lines = pending.split(RECORD_SEPARATOR);
        pending = lines.pop();
        for (const line of lines) {
          // What a line MEANS is the protocol's business, not this loop's. [LAW:one-source-of-truth]
          const report = readReport(line);
          // Once the app is running, only a TUI still owes a first frame: it paints within a second
          // and a half, so silence past the deadline is the hang this check exists for. Print mode
          // owes no frame — it can legitimately think for minutes before writing a byte — and
          // killing it at the deadline would end work that was going fine, then re-run it.
          if (report.kind === 'started') { started = true; if (!tui) clearTimeout(timer); }
          else if (report.kind === 'painted') { paintedAt = paintedAt || Date.now(); clearTimeout(timer); }
          else if (report.kind === 'absent-api') absentApis.push(report.name);
          else if (report.kind === 'refusal') refusal = refusal || report.reason; // the FIRST: the root cause
        }
      };
      // The last report a dying host writes is the one most worth having, and it is the one most
      // likely to arrive without its separator — a SIGKILL at the deadline, or a partial flush on
      // the way down. Flushing the decoder and treating what is left as a final record is what keeps
      // that reason from being replaced by the launcher's own poorer guess. A second flush after the
      // first reads an empty line, which the protocol already answers as `blank`.
      // [LAW:no-silent-failure]
      const drain = () => consume(decoder.end() + RECORD_SEPARATOR);
      const finish = () => { channelDone = true; settle(); };
      channel.on('data', (chunk) => consume(decoder.write(chunk)));
      // A boot channel that fails to read is a lost diagnosis, not a non-event: without this the
      // failure reason would silently be the poorer one. The drain comes first so a refusal the host
      // did manage to write outranks this reader's account of its own trouble.
      // [LAW:no-silent-failure]
      channel.on('error', (e) => { drain(); refusal = refusal || `boot channel unreadable: ${e.message}`; finish(); });
      channel.on('end', () => { drain(); finish(); });
      channel.on('close', () => { drain(); finish(); });
    }

    // Every way out of this promise detaches the handlers, this one included: a plan that never
    // started still installed them, and one left aimed at a child that does not exist would swallow
    // the next plan's Ctrl+C.
    child.on('error', (e) => { clearTimeout(timer); stopSupervising(); resolve({ booted: false, reason: `could not start ${plan.command}: ${e.message}` }); });
    // The instant of the exit, not the instant the verdict is formed: settle() also waits on the
    // boot channel closing, and a slow close would otherwise be counted as time the session lived.
    child.on('exit', (code, signal) => { ended = { code, signal, at: Date.now() }; settle(); });
  });
}

// Run the plans in order and return the exit code of the one that booted.
async function launch(binaryPath, userArgs, io = {}) {
  const log = io.log || ((line) => process.stderr.write(line + '\n'));
  const reset = io.reset || resetTerminal;
  const runPlan = io.run || run;

  // The invocation is parsed into its one fact HERE, at the entry point, and carried down as a
  // value — so nothing downstream re-derives it from whatever it happens to be able to see.
  // [LAW:parse-dont-validate]
  const tui = rendersTui(userArgs, io.terminal ?? attachedToTerminal());

  const candidates = io.plans || plans(binaryPath, userArgs);
  for (const plan of candidates) {
    const result = await runPlan(plan, { ...io, tui });
    if (result.booted) return result.code;
    // The terminal goes back BEFORE the reason is written into it. TERMINAL_RESET leads with the
    // escape that DISCARDS the alternate screen buffer, so a line logged first lands in the buffer
    // the next call throws away — and the failure that most needs explaining is exactly the one
    // where a plan painted a TUI and then died. [LAW:no-silent-failure] the degrade is never quiet:
    // the next session is not the one the user asked for, and the reason has to be findable.
    reset();
    log(`cc-extra: ${plan.name} session did not start — ${result.reason}; falling back`);
  }
  // Unreachable while the last plan is the floor; if the list ever ends without one, say so loudly
  // rather than exiting 0 on a session that never ran.
  log('cc-extra: no plan produced a session');
  return 70;
}

module.exports = {
  BOOT_DEADLINE_MS, BOOT_SETTLE_MS, BOOT_FD, TERMINAL_RESET,
  TERMINAL_SIGNALS, ADDRESSED_SIGNALS, SUPERVISED_SIGNALS,
  resetTerminal, attachedToTerminal, hasControllingTerminal, rendersTui, superviseSignals, exitStatus, plans, run, launch,
};

if (require.main === module) (async function main() {
  const [binaryPath, ...userArgs] = process.argv.slice(2);
  if (!binaryPath) {
    process.stderr.write('usage: launch.js <installed-claude-binary> [claude args...]\n');
    process.exit(2);
  }
  process.exitCode = await launch(binaryPath, userArgs);
})();
