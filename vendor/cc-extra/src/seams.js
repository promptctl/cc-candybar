// seams.js — the fragments of the app's own source the injector anchors on, and what it splices in.
//
// This file is the ONLY place in the tree that knows anything about Claude Code's internals, and a
// seam deliberately knows as little as possible: one fragment of source, and one statement to insert
// before it. Everything else — which module carries it, at what offset — is resolved from the
// installed binary at launch by seam-plan.js. There is no chunk name here and no version literal,
// because both change every release and a map that changes weekly is a map that is already lying.
//
// WHY THESE ANCHORS SURVIVE MINIFICATION. Bun renames every module-scope binding — the gate function
// below was renamed between two releases a week apart — but it cannot rename a PROPERTY, and it
// cannot rewrite a STRING LITERAL the app sends to a server. Property names and literals come
// through verbatim. Anchoring on one of those rather than on an offset, a variable, or a line number
// is what makes this hold across releases without a table someone maintains by hand. No minified
// name is spelled here: the one place any of them appears is the dated measurement below.

'use strict';

// The global a spliced statement calls. The host installs it before a single module is evaluated,
// which is why inserted code can call it unguarded — an absent registrar is unrepresentable rather
// than survivable. [LAW:no-defensive-null-guards]
const REGISTRAR = '__CC_EXTRA_SEAM__';

// THE PROPOSE-GOAL SEAM — give the model the goal tool the shipped build already carries.
//
// `/goal` has two shipped forms. The one a person types is a slash command; the one the MODEL can
// reach is a real tool, `ProposeGoal`, which enqueues `/goal <condition>` on the session's own
// message queue — the shipped way a tool runs a slash command. That tool is already built, already
// in `getAllBaseTools()`'s array, and already excluded from the offered set by its own `isEnabled()`.
//
// MEASURED on the shipped 2.1.280 (a dated observation, not an input — nothing below reads it, and
// every name in it is minified and already different from 2.1.278's). `isEnabled()` is five
// conjuncts, and on an ordinary interactive local session exactly one of them is false:
//
//     isEnabled(){ if(Te()||Zn())return!1; if(At())return!1; if(!Pjt())return!1;
//                  let e=pze(); if(e==="disabled")return!1; return E(e),!0 }
//
//   Te()   — the session is NOT interactive.     false here: it is.
//   Zn()   — the workspace is remote.            false here: it is local.
//   At()   — `s9()==="bg"`, a background job.    false here: it is a terminal session.
//   pze()  — the `modelProposedGoals` setting, `"auto"` when absent, and only `"disabled"` refuses.
//   Pjt()  — `x("tengu_propose_goal",!1)`, a SERVER-SIDE feature gate, default false. This one.
//
// WHY THE GATE AND NOT THE TOOL. That gate is the app's single authority on whether the goal feature
// exists at all: the tool's `isEnabled` reads it, and so does the `/config` panel, which shows the
// `modelProposedGoals` row only when the gate is on. Splicing the gate turns the feature on once, at
// its source, and both consumers agree by construction. Splicing `isEnabled` instead would leave a
// session whose goal tool works and whose settings panel denies the tool exists — two maps of one
// fact, drifting the moment either is read. [LAW:one-source-of-truth] [LAW:single-enforcer]
//
// WHY NOT CONFIGURATION. Feature values resolve environment override -> config override -> remote
// payload -> disk cache -> default, and on a shipped build the first two are compiled to
// `return null` / `return`. When the remote payload is non-empty but lacks the key the resolver
// returns the default and SKIPS the disk cache entirely, so seeding the cache does nothing — and
// writing it would make this a second writer to a file the gate client owns and rewrites on its own
// schedule. The gate is a runtime value; the only honest place to change it is at runtime.
//
// WHY THE ANCHOR IS SHAPED THE WAY IT IS. `"tengu_propose_goal"` is a key the app sends to a feature
// service, so it survives minification untouched and occurs exactly ONCE across all 1,991 js modules.
// The rest of the anchor is not there to find the site — the literal already did that — it is there
// to PROVE the site is a statement whose value is the gate's answer, because the only insertion that
// could go wrong here is one absorbed into a larger expression that inverts it:
//
//   the        `function <name>(){` pins the brace to a FUNCTION BODY, so the spliced `return true;`
//   lookbehind is provably the first statement that function runs, and the leading `[;}\n]` pins that
//              declaration to a STATEMENT POSITION — a function declaration, never an expression
//              whose value an enclosing operator consumes. Neither half is ornamental. A lookbehind
//              of just `\{` admits `if(W()){return P(...)}else{...}`: it resolves to one site,
//              splices cleanly, and leaves a gate that still answers the server on the other branch
//              — resolved to the wrong place and still running, which is the one failure this whole
//              anchor exists to prevent. Without `[;}\n]`, `return!function R(){return P(...)}()`
//              admits the same way, and there an operator inverts what the splice returns. The
//              `function ` keyword carries its own weight: `\w+ ` in its place admits the valid class
//              members `get G(){`, `async G(){` and `static G(){`.
//              IT DOES NOT PROVE NESTING DEPTH — no regex counts braces. A declaration inside another
//              function body still matches whenever `;`, `}` or a newline precedes it, and
//              `seams.test.js` pins that as the known limit rather than implying it away. Proving top
//              level would take a parser, and it would refuse the one nesting that actually occurs: a
//              Bun `__esm`/`__commonJS` chunk wrapper, where the nested declaration IS the gate and
//              splicing into it is correct. The residual is a hand-written
//              `function outer(){…function R(){gate}return!R()}`, which minification does not produce
//              from this source. The lookbehind is variable-length, which V8 supports and most
//              engines do not; node is the only host here, so that is a fact rather than a bet.
//   `\s+`      a `return` whose operand is a call has to be separated from it, so requiring the
//              space is what tells `return P(...)` apart from a call to a function NAMED
//              `returnP(...)`. `\s*` would match the second and splice a return into a function
//              that never asked the gate anything. (A negated call, `return!P(...)`, is refused by
//              the identifier class that follows, not by this.)
//   the quote  the closing `"` pins the exact key, so a future `"tengu_propose_goal_v2"` refuses
//              instead of resolving onto a gate that means something else.
//
// Every one of those is a REFUSAL when the shape moves, and a refusal costs the user the hosted
// session and never a working one: the host reports `no-module-carries-the-seam` and the caller falls
// back to stock claude. A seam that resolved to the wrong place is the failure worth engineering
// against, because that one still runs. [LAW:no-silent-failure]
//
// A patch enters this list as a VALUE — an anchor and the statement to insert — and every other part
// of the mechanism is already unconditional: the plan is resolved, the transform is applied and the
// registrar is installed on every boot, whether this list holds one seam or ten. Adding a patch is
// adding data, never a new path. [LAW:dataflow-not-control-flow]
// THE STATUSLINE-PUSH SEAM — draw the status line from frames cc-candybar's daemon pushes
// (statusline-push.js says why and how).
//
// MEASURED on the shipped 2.1.299 (dated, not an input). The status line controller is one class;
// it draws through a PRIVATE emitter, and runs the command from an arrow inside its own method:
//
//     #R(e,n,r,s){ … await _Yo({signal:e, executeCommand:()=>{ let M=this.#t, z=kYo({…});
//                    if(!e.aborted)this.#b(wYo(z)); return this.#e.execute(z,e,r) },
//                  getCommandLength:()=>…, pendingResultLogRef:this.#g, onResult:(M)=>this.#S(M), … }) }
//     #S(e){ if(this.#n.text===e)return; this.#n={text:e}; …; this.#o.emit() }
//
// `z` is the statusline JSON, `this.#e.execute(z,e,r)` runs the command, and `#S` is what its output
// is drawn through. A private name can only be written inside the class body, which is exactly where
// this splice lands: `this` is the controller and `this.#S` is reachable. The anchor CAPTURES the
// pieces the insert needs — the deps field, the payload, the run's other two arguments, the emitter —
// so no minified name is written here; each is read off the release being spliced.
//
// THE SHAPE OF THE INSERT. A splice only adds text before its anchor, and the anchor is the command
// call itself, so the original call stays after the insert as the right operand of `||`:
//
//     return <registrar>.statusLine(this, z, (t)=>this.#S(t), ()=>this.#e.execute(z,e,r)) || this.#e.execute(z,e,r)
//
// `statusLine` is async, so it always returns a promise and the right operand never runs; the run
// goes through the thunk the registrar is handed, once.
//
// WHY THE ANCHOR IS SHAPED THE WAY IT IS. `.execute(` alone occurs all over the graph; what makes
// this one the status line's is what follows it — the `getCommandLength:` key of the same object
// literal, then that literal's `onResult:` arrow into a private method — keys the minifier cannot
// rename. `(?<=return )` pins the anchor to the operand of the arrow's `return`, so the `||` lands in
// a return expression and nowhere an operator could absorb it. The `[^]{0,400}?` between
// `getCommandLength:` and `onResult:` spans the two keys between them in this literal (about 120
// characters in 2.1.299); bounded, so it cannot reach into another object literal's `onResult:`.
// Resolved to exactly one site in every installed release, 2.1.267 through 2.1.299.
const STATUSLINE_PUSH = {
  name: 'statusline-push',
  anchor:
    /(?<=return )this\.(?<deps>#[\w$]+)\.execute\((?<payload>[\w$]+),(?<rest>[\w$]+,[\w$]+)\)(?=\},getCommandLength:[^]{0,400}?onResult:\([\w$]+\)=>this\.(?<emit>#[\w$]+)\()/,
  insert: `globalThis.${REGISTRAR}.statusLine(this,$<payload>,(t)=>this.$<emit>(t),()=>this.$<deps>.execute($<payload>,$<rest>))||`,
  // THE BREAKPOINT FORM, for a stock Bun session reached over its inspector (bun-attach.js), where
  // nothing can be spliced. A breakpoint on the `return` the anchor stands after — the lookbehind is
  // why the offset is minus its length — evaluates `action` in the controller's own frame on every
  // command run, without pausing. That frame is inside the class body, so `this.#S` evaluates there
  // (MEASURED on 2.1.299: JSC accepts the private name in-frame), and the action hands the registrar
  // the controller, its deps object and its emitter. The registrar wraps `deps.execute` once, so the
  // run answers with the newest pushed frame exactly as the splice's `||` does. Wrapping deps is
  // per-controller because the app builds a fresh deps object literal for each controller it
  // constructs (2.1.299). A breakpoint cannot replace a return value, which is why the wrap and not
  // the action is what changes the answer.
  attach: {
    offset: -'return '.length,
    action: `globalThis.${REGISTRAR}.attachStatusLine(this,this.$<deps>,(t)=>this.$<emit>(t))`,
  },
};

const SEAMS = [
  {
    name: 'propose-goal',
    anchor: /(?<=[;}\n]function [A-Za-z_$][\w$]*\(\)\{)return\s+[A-Za-z_$][\w$]*\("tengu_propose_goal"/,
    insert: 'return true;',
  },
  STATUSLINE_PUSH,
];

module.exports = { REGISTRAR, SEAMS };
