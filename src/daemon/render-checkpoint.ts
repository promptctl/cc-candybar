// The one crossing an untrusted render request makes into a checked one.

import { parseArgs } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { explicitConfigPath, type UserHome } from "../utils/user-path";
import { detectClientHints } from "../client-hints";
import {
  CONFIG_FLAGS,
  isConfigFlag,
  requestedConfigTarget,
  type RequestedTarget,
} from "../config-hint";
import {
  parseClientHints,
  ENVIRONMENT_NEEDED,
  refusedHints,
  RENDER_ENCODINGS,
  type ReaderRenderRequest,
  type SessionRenderRequest,
  type RefusedArg,
  type RenderEncoding,
} from "./foundations/protocol";
import { parseSessionId, type SessionId } from "./foundations/session-id";
import type { RuntimeStats } from "./stats";
import type { DaemonLogger } from "../utils/logger";
import { validateHookData } from "../utils/schema-validator.js";
import { rateLimitsSeen } from "./render-sightings";
import type { CheckedRenderRequest } from "../renderer-interface/request-context.js";
import { parseClientDeadline } from "./foundations/request-deadline.js";
import {
  sessionEnvironment,
  environmentKey,
  type Environment,
  type RegisteredEnvironment,
  type SessionFacts,
  type SessionEnvironment,
} from "./foundations/session-env.js";

// [LAW:single-enforcer][LAW:no-silent-failure] Both config flags name paths
// relative to the client. The last config flag decides the path and scope.
// Tokens also carry every refused flag or positional for the bar's error.
function parseRenderArgs(
  args: string[],
  cwd: string,
  home: UserHome,
  configEnv: string | undefined,
):
  | { target: RequestedTarget; refusedArgs: readonly RefusedArg[] }
  | { problem: string } {
  const { tokens } = parseArgs({
    args: args.slice(1), // skip binary path
    options: CONFIG_FLAGS,
    strict: false,
    tokens: true,
    allowPositionals: true,
  });
  // A value-taking option in loose parseArgs can consume another option.
  // Refuse that ambiguity for the config flags, before discovering anything.
  for (const token of tokens ?? []) {
    if (
      token.kind === "option" &&
      isConfigFlag(token.name) &&
      token.inlineValue === false &&
      token.value?.startsWith("--") &&
      isConfigFlag(token.value.slice(2).split("=", 1)[0] ?? "")
    )
      return {
        problem: token.rawName + " names no file before " + token.value,
      };
  }
  // [LAW:one-source-of-truth] The last config option decides both the path and
  // whether it is refused, so the two cannot disagree.
  const config = (tokens ?? [])
    .filter(
      (t): t is Extract<typeof t, { kind: "option" }> =>
        t.kind === "option" && isConfigFlag(t.name),
    )
    .at(-1);
  const path = explicitConfigPath(cwd, config?.value, home);
  if (config?.name === "config-only" && path === undefined)
    return { problem: "--config-only needs a path" };
  const refused = (tokens ?? []).flatMap((t): RefusedArg[] => {
    switch (t.kind) {
      case "option":
        return !isConfigFlag(t.name)
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
    target: requestedConfigTarget(
      path,
      configEnv,
      config?.name === "config-only" ? "config-only" : "config",
    ),
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

type CheckedRender =
  | {
      ok: true;
      req: CheckedRenderRequest;
      // Both stay with the host. The renderer receives only req.
      environment: SessionEnvironment;
      registration: RegisteredEnvironment | null;
    }
  | { ok: false; problems: string[] };

type CheckInputs = [
  stats: Pick<RuntimeStats, "firstSightOfUnknownHookField">,
  log: DaemonLogger,
  home: string,
];
interface EnvironmentLookup {
  readonly reportedFor: (
    session: SessionId,
    key: string,
  ) => RegisteredEnvironment | null;
  readonly accountHome: () => string;
}
interface EnvironmentChallenge {
  readonly need: typeof ENVIRONMENT_NEEDED;
}

// A full render always has a final verdict. A reference can ask for a snapshot
// once its hook, arguments, session id and deadline have crossed this checkpoint.
export function checkRenderRequest(
  req: ReaderRenderRequest,
  ...inputs: [...CheckInputs, lookup?: EnvironmentLookup]
): CheckedRender;
export function checkRenderRequest(
  req: ReaderRenderRequest | SessionRenderRequest,
  ...inputs: [...CheckInputs, lookup: EnvironmentLookup]
): CheckedRender | EnvironmentChallenge;
export function checkRenderRequest(
  req: ReaderRenderRequest | SessionRenderRequest,
  stats: CheckInputs[0],
  log: DaemonLogger,
  home: string,
  lookup?: EnvironmentLookup,
): CheckedRender | EnvironmentChallenge {
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
  // The project directory too: it resolves the project's config layer and is
  // kept in the session book, which reads back only absolute paths. Its
  // type is the schema's, checked above.
  const projectDir: unknown = req.hookData?.workspace?.project_dir;
  if (typeof projectDir === "string" && !isAbsolute(projectDir)) {
    wireProblems.push(
      `field 'workspace.project_dir' is not an absolute path: ${JSON.stringify(projectDir)}`,
    );
  }
  // [LAW:single-enforcer] This directory selects the host's checkout
  // observation. A reported path is absolute. Only an omitted one uses cwd.
  const currentDir = req.hookData?.workspace?.current_dir;
  if (typeof currentDir === "string" && !isAbsolute(currentDir)) {
    wireProblems.push(
      `field 'workspace.current_dir' is not an absolute path: ${JSON.stringify(currentDir)}`,
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
  const presented = readEnvironment(req);
  if (presented.kind === "refused") wireProblems.push(presented.problem);
  const encoding = parseRenderEncoding(req.encoding);
  if (!encoding.ok) wireProblems.push(encoding.problem);
  const deadline = parseClientDeadline(
    (req as { deadline?: unknown }).deadline,
  );
  if (deadline.kind === "refused")
    return { ok: false, problems: [...wireProblems, deadline.problem] };
  if (
    wireProblems.length > 0 ||
    !sessionId.ok ||
    !encoding.ok ||
    presented.kind === "refused"
  )
    return { ok: false, problems: wireProblems };
  let env: Exclude<PresentedEnvironment, { kind: "refused" }>;
  if (presented.kind === "reference") {
    const previous = lookup?.reportedFor(sessionId.id, presented.key);
    if (!previous) return { need: ENVIRONMENT_NEEDED };
    env = {
      kind: "reported",
      env: previous.reported,
      key: previous.key,
      previous,
    };
  } else {
    env = presented;
  }
  const keyed =
    env.kind === "reported" && env.key !== undefined ? env.env : undefined;
  // HOME may be relative to the live client. If it is unset, expand a tilde
  // using the account's home, independent of the shell that started the host.
  const clientHome = keyed
    ? keyed.HOME
      ? resolve(req.cwd, keyed.HOME)
      : (lookup?.accountHome ?? home)
    : home;
  // A keyed report is the source of the environmental hints. The physical
  // terminal and the program that sent the request are live observations.
  const rawHints = keyed
    ? {
        ...detectClientHints({ env: keyed, home: clientHome }, req.cwd, {}),
        ...(req.termCols !== undefined && { termCols: req.termCols }),
        ...(req.termRows !== undefined && { termRows: req.termRows }),
        client: req.client,
      }
    : req;
  const hints = parseClientHints(rawHints);
  // [LAW:dataflow-not-control-flow] The *request's* cwd, not the daemon's
  // process.cwd(), so config resolution depends only on request data — the
  // daemon's own working directory must not influence output.
  const parsedArgs = parseRenderArgs(
    req.args,
    req.cwd,
    clientHome,
    hints.configEnv,
  );
  if ("problem" in parsedArgs)
    return { ok: false, problems: [parsedArgs.problem] };
  const { target, refusedArgs } = parsedArgs;
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
  return {
    ok: true,
    ...environmentForSession(env, {
      sessionId: sessionId.id,
      projectDir: req.hookData.workspace.project_dir,
      claudeConfigDir: hints.claudeConfigDir,
    }),
    req: {
      v: req.v,
      kind: "render",
      cwd: req.cwd,
      args: req.args,
      ...hints,
      // Existing workers show a diagnostic for an explicitly refused hint.
      // Forward only the declared fields they need for that diagnostic.
      ...Object.fromEntries(
        refusedHints(rawHints, hints).map(({ hint, sent }) => [hint, sent]),
      ),
      hookData: {
        ...req.hookData,
        session_id: sessionId.id,
        workspace: {
          ...req.hookData.workspace,
          current_dir: currentDir ?? req.cwd,
        },
      },
      deadline,
      encoding: encoding.encoding,
      hints,
      rateLimits: rateLimitsSeen(req.hookData),
      requested: {
        projectDir: req.hookData.workspace.project_dir,
        cwd: req.cwd,
        target,
      },
      refusedArgs,
    } as CheckedRenderRequest,
  };
}

// A client older than the host sends no environment, and the host runs no
// program for its session in one of its own.
const UNREPORTED =
  "this session's client sent no environment, so it is older than the daemon; update cc-candybar so its programs can run";

// [LAW:parse-dont-validate] The environment a client sent: absent from a
// client too old to send one, else every variable a string.
type PresentedEnvironment =
  | { readonly kind: "absent" }
  | {
      readonly kind: "reported";
      readonly env: Environment;
      readonly key?: string;
      readonly previous?: RegisteredEnvironment;
    }
  | { readonly kind: "refused"; readonly problem: string };

const validKey = (key: unknown): key is string =>
  typeof key === "string" && key.length === 64 && !/[^a-f0-9]/.test(key);

function environmentForSession(
  env: Exclude<PresentedEnvironment, { kind: "refused" }>,
  facts: SessionFacts,
): {
  environment: SessionEnvironment;
  registration: RegisteredEnvironment | null;
} {
  if (env.kind === "absent")
    return {
      environment: { kind: "failed", reason: UNREPORTED },
      registration: null,
    };
  const { previous } = env;
  if (
    previous &&
    previous.projectDir === facts.projectDir &&
    previous.claudeConfigDir === facts.claudeConfigDir
  )
    return {
      environment: { kind: "ok", value: previous.execution },
      registration: previous,
    };
  const execution = sessionEnvironment(env.env, facts);
  const registration =
    env.key === undefined
      ? null
      : {
          key: env.key,
          reported: env.env,
          projectDir: facts.projectDir,
          claudeConfigDir: facts.claudeConfigDir,
          execution,
        };
  return { environment: { kind: "ok", value: execution }, registration };
}

function readEnvironment(
  req: ReaderRenderRequest | SessionRenderRequest,
): PresentedEnvironment | { kind: "reference"; key: string } {
  const key = req.envKey;
  if ((req.kind !== "render" || key !== undefined) && !validKey(key))
    return {
      kind: "refused",
      problem: "request 'envKey' is not a SHA-256 digest",
    };
  if (req.kind !== "render") return { kind: "reference", key: req.envKey };
  const raw: unknown = req.env;
  if (key !== undefined && raw === undefined)
    return {
      kind: "refused",
      problem: "request 'envKey' has no accompanying environment",
    };
  if (raw === undefined) return { kind: "absent" };
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !Object.values(raw).every((value) => typeof value === "string")
  )
    return {
      kind: "refused",
      problem: "request 'env' is not an object of strings",
    };
  const env = raw as Environment;
  if (key !== undefined && environmentKey(env) !== key)
    return {
      kind: "refused",
      problem: "request 'envKey' does not match its environment",
    };
  return { kind: "reported", env, key };
}
