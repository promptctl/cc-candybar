// attach-registrar.js — the registrar a stock Bun session gets over its inspector, and the source text
// that installs it there.
//
// The hosted session builds its registrar in bun-host.mjs, in the same process as the graph it
// splices. An attached session is a different process — a stock binary this launcher can only reach by
// evaluating source in it — so the registrar crosses as TEXT: `installRegistrar` below, serialized
// with Function.prototype.toString, and statusline-push.js's own file, wrapped as a module. Nothing is
// re-spelled for the trip: the subscription logic that runs in the attached process is the same file
// the hosted one requires. [LAW:one-source-of-truth]
//
// Because it crosses as text, `installRegistrar` may use NOTHING from this module's scope: every
// value it needs is a parameter, and the suite evaluates the serialized form in an empty context to
// hold it to that.

'use strict';

const fs = require('fs');
const path = require('path');

// Runs INSIDE the attached process. `statusLinePush` is statusline-push.js's exports; `io` is the
// process's own fs and net, and `env` its environment.
function installRegistrar({ registrar, logPath }, statusLinePush, io, env, pid, uid) {
  // [LAW:no-silent-failure] exception: this log is the only channel out of the user's session, and it
  // is written from the push's socket handlers inside the app — a write it cannot make (a full disk)
  // must cost the line, never throw into the app and take the session down with it.
  const report = (line) => { try { io.fs.appendFileSync(logPath, `${new Date().toISOString()} ${pid} ${line}\n`); } catch {} };
  const push = statusLinePush.createStatusLinePush({
    connect: (socketPath) => io.net.createConnection(socketPath),
    socketPath: statusLinePush.daemonSocketPath(env, uid),
    report,
  });
  // The deps objects already wrapped. A breakpoint action runs on EVERY command run, and the wrap must
  // happen once per controller: wrapping twice would run the command through two subscriptions.
  const wrapped = new WeakSet();
  globalThis[registrar] = {
    // Called from the breakpoint on every command run, in the controller's frame. Answers what it did,
    // so the launcher can log the first hit and any that fail.
    attachStatusLine(controller, deps, emit) {
      if (wrapped.has(deps)) return 'held';
      wrapped.add(deps);
      const run = deps.execute;
      deps.execute = (payload, ...rest) => push.statusLine(controller, payload, emit, () => run.call(deps, payload, ...rest));
      report('statusline-push attached to a status line controller');
      return 'attached';
    },
  };
  report('registrar installed');
}

// statusline-push.js as an expression that evaluates to its exports: a CommonJS module body run
// inside a function that hands it `module` and `exports`. It requires nothing, which is what lets it
// cross as text.
const moduleExpression = (source) => `(() => { const module = { exports: {} }; ((module, exports) => {\n${source}\n})(module, module.exports); return module.exports; })()`;

// The one expression the launcher evaluates in the attached process, at entry, before release. Strict
// from its first line, because this file's own 'use strict' does not cross as text: an assignment that
// does not take — `deps.execute` frozen in some release — throws and is reported as a failed hit, never
// logged as 'attached'.
function registrarSource({ registrar, logPath }) {
  const statusLinePush = fs.readFileSync(path.join(__dirname, 'statusline-push.js'), 'utf8');
  return `'use strict'; (${installRegistrar.toString()})(${JSON.stringify({ registrar, logPath })}, ${moduleExpression(statusLinePush)}, ` +
    `{ fs: process.getBuiltinModule('node:fs'), net: process.getBuiltinModule('node:net') }, process.env, process.pid, process.getuid())`;
}

module.exports = { installRegistrar, registrarSource };
