// The one crossing an untrusted render request makes into a checked one.

import { parseArgs } from "node:util";
import { isAbsolute } from "node:path";
import { explicitConfigPath } from "../utils/user-path";
import { requestedConfigTarget, type RequestedOrigin } from "../config-hint";
import { parseClientHints, RENDER_ENCODINGS } from "./protocol";
import type {
  ClientHints,
  ReaderRenderRequest,
  RefusedArg,
  RenderEncoding,
} from "./protocol";
import { parseSessionId, type SessionId } from "./session-id";
import type { RuntimeStats } from "./stats";
import type { DaemonLogger } from "../utils/logger";
import { validateHookData } from "../utils/schema-validator.js";
import { rateLimitsSeen, type RateLimitsSeen } from "./render-sightings";
import {
  parseClientDeadline,
  type ClientDeadline,
} from "./request-deadline.js";

// [LAW:single-enforcer][LAW:no-silent-failure] Parse render-path args with
// the standard util at the trust boundary. `--config <path>` is the sole
// valid render flag; every other flag, a `--config` with no path after it,
// and a positional word are refused arguments the caller shows as the bar's
// error and on the render event.
// The `--config` value crosses `explicitConfigPath` against the CLIENT's cwd
// (the request's, brandon-config-nuq6), the rule the client applies to its
// `configEnv` hint: empty is no override, `~` is expanded once, here.
//
// `tokens: true, strict: false, allowPositionals: true` together let the
// parser emit a token entry for every flag (known or unknown) without
// throwing on unknown ones, and without mis-classifying their values as
// positionals. Not strict, `--config` takes whatever follows it as its
// value, so only the last token can be a bare `--config`, and being last it
// is the one that wins.
function parseRenderArgs(
  args: string[],
  cwd: string,
): {
  configFile: string | undefined;
  refusedArgs: readonly RefusedArg[];
} {
  const { tokens } = parseArgs({
    args: args.slice(1), // skip binary path
    options: { config: { type: "string" } },
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  // [LAW:one-source-of-truth] The last `--config` decides both the path and
  // whether it is refused, so the two cannot disagree.
  const config = (tokens ?? [])
    .filter(
      (t): t is Extract<typeof t, { kind: "option" }> =>
        t.kind === "option" && t.name === "config",
    )
    .at(-1);
  const refused = (tokens ?? []).flatMap((t): RefusedArg[] => {
    switch (t.kind) {
      case "option":
        return t.name !== "config"
          ? [{ arg: t.rawName, why: "unknown" }]
          : t === config && t.value === undefined
            ? [{ arg: t.rawName, why: "no-value" }]
            : [];
      case "positional":
        return [{ arg: t.value, why: "positional" }];
      // `--` only ends the flags; the words after it are positionals.
      case "option-terminator":
        return [];
    }
  });
  return {
    configFile: explicitConfigPath(cwd, config?.value),
    // In argv order, each refusal once.
    refusedArgs: refused.filter(
      (r, i) =>
        refused.findIndex((o) => o.arg === r.arg && o.why === r.why) === i,
    ),
  };
}

// [LAW:parse-dont-validate] The request's `encoding`: absent is `ansi`, what a
// client sends by saying nothing, and anything else is refused, never read as
// `ansi`: a reader would parse bytes it did not ask for.
function parseRenderEncoding(
  raw: unknown,
): { ok: true; encoding: RenderEncoding } | { ok: false; problem: string } {
  if (raw === undefined) return { ok: true, encoding: "ansi" };
  const encoding = RENDER_ENCODINGS.find((name) => name === raw);
  return encoding !== undefined
    ? { ok: true, encoding }
    : {
        ok: false,
        problem: `request 'encoding' is not one of ${RENDER_ENCODINGS.join(", ")}: ${JSON.stringify(raw)}`,
      };
}

// A render request that crossed the checkpoint: its hookData carries every
// required field with its declared type, its cwd is absolute, `hints` is its
// client hints, parsed, and its args are parsed into `requested` — the config
// inputs it named, its explicit path the `--config` flag over the client's
// `CC_CANDYBAR_CONFIG` hint — and `refusedArgs`, `rateLimits` is
// what its hookData says of the rate-limit windows, and `deadline` is when its
// client hangs up. Raw `req.*` hint fields and `req.args` are not read past
// the checkpoint. `encoding` is how its answer is spelled. Only
// checkRenderRequest makes one.
declare const CHECKED: unique symbol;
export type CheckedRenderRequest = Omit<
  ReaderRenderRequest,
  "deadline" | "encoding"
> & {
  readonly deadline: ClientDeadline;
  readonly encoding: RenderEncoding;
  readonly sessionId: SessionId;
  readonly hints: ClientHints;
  readonly rateLimits: RateLimitsSeen;
  readonly requested: RequestedOrigin;
  readonly refusedArgs: readonly RefusedArg[];
  readonly [CHECKED]: true;
};

// [LAW:parse-dont-validate] The checkpoint a render request crosses once: a
// checked request, or the problems that refuse it.
export function checkRenderRequest(
  req: ReaderRenderRequest,
  stats: Pick<RuntimeStats, "firstSightOfUnknownHookField">,
  log: DaemonLogger,
): { ok: true; req: CheckedRenderRequest } | { ok: false; problems: string[] } {
  // [LAW:single-enforcer] One trust-boundary check for incoming hookData.
  // The validator reports missing/wrong-typed required fields and unknown
  // top-level keys. Required-field problems are *protocol* failures
  // (Claude Code's schema guarantees these — their absence means the
  // sender is broken or malicious); unknown fields are advisory (Anthropic
  // may have added something).
  const { report } = validateHookData(req.hookData as unknown);
  // [LAW:no-silent-failure][LAW:types-are-the-program] Gate hard on
  // schema violations. Continuing with `workspace?.project_dir` would
  // collapse "absent" into an empty-string cache key — silently sharing
  // one entry across every malformed request — and downstream code would
  // have to defend against an empty projectDir forever. Reject here so
  // the types downstream carry the strongest true theorem: by the time
  // a cache entry is built, projectDir/cwd are real non-empty strings.
  const wireProblems: string[] = [];
  for (const path of report.missingRequired) {
    wireProblems.push(`missing required field '${path}'`);
  }
  for (const { path, expected, got } of report.typeMismatches) {
    wireProblems.push(`field '${path}' expected ${expected}, got ${got}`);
  }
  // [LAW:single-enforcer] The session id crosses the one session-id
  // checkpoint, as a subscribe's and a click's do.
  const sessionId = parseSessionId(req.hookData?.session_id);
  if (!sessionId.ok) {
    wireProblems.push(`field 'session_id' ${sessionId.problem}`);
  }
  // [LAW:parse-dont-validate] Absolute, not merely non-empty: the
  // request's cwd anchors a relative `--config` (parseRenderArgs), and a
  // relative anchor would resolve against the daemon's own cwd
  // (brandon-config-nuq6). Both clients send their process cwd.
  // The cwd is untrusted JSON too: a value that is not a string is refused
  // here, never handed to isAbsolute, which would throw past the render event.
  if (typeof req.cwd !== "string" || !isAbsolute(req.cwd)) {
    wireProblems.push(
      `request 'cwd' is not an absolute path: ${JSON.stringify(req.cwd)}`,
    );
  }
  // The args too: parseRenderArgs reads them below, outside the render's own
  // error path, so a value that is not a list of strings is refused here
  // rather than thrown past the render event.
  if (
    !Array.isArray(req.args) ||
    !(req.args as unknown[]).every((a) => typeof a === "string")
  ) {
    wireProblems.push(
      `request 'args' is not a list of strings: ${JSON.stringify(req.args)}`,
    );
  }
  const encoding = parseRenderEncoding(req.encoding);
  if (!encoding.ok) wireProblems.push(encoding.problem);
  const deadline = parseClientDeadline(
    (req as { deadline?: unknown }).deadline,
  );
  if (deadline.kind === "refused")
    return { ok: false, problems: [...wireProblems, deadline.problem] };
  if (wireProblems.length > 0 || !sessionId.ok || !encoding.ok)
    return { ok: false, problems: wireProblems };
  // [LAW:nothing-unseen] Said once per daemon, at its first sight: every
  // request carries the field, and a line each rotated the log in minutes.
  // The stats snapshot lists them all, and only a request the checkpoint
  // passed adds one: what a refused request says is not recorded as fact.
  for (const field of report.unknownTopLevelFields) {
    if (stats.firstSightOfUnknownHookField(field)) {
      log(
        "info",
        `schema: unknown field ${JSON.stringify(field)} — Anthropic may have added it`,
      );
    }
  }
  const hints = parseClientHints(req);
  // [LAW:dataflow-not-control-flow] The *request's* cwd, not the daemon's
  // process.cwd(), so config resolution depends only on request data — the
  // daemon's own working directory must not influence output.
  const { configFile, refusedArgs } = parseRenderArgs(req.args, req.cwd);
  return {
    ok: true,
    req: {
      ...req,
      deadline,
      encoding: encoding.encoding,
      sessionId: sessionId.id,
      hints,
      rateLimits: rateLimitsSeen(req.hookData),
      requested: {
        projectDir: req.hookData.workspace.project_dir,
        cwd: req.cwd,
        target: requestedConfigTarget(configFile, hints.configEnv),
      },
      refusedArgs,
    } as CheckedRenderRequest,
  };
}
