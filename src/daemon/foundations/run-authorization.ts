import type { LinkSigner } from "../../click/link-signer.js";
import { runLinkFields, type RunEvidence } from "../../click/wire.js";
import type { Act } from "../../renderer-interface/interface.js";
import type { Asked } from "../../utils/outcome.js";
import { failureOf } from "./host-failure.js";

export type RequestedRun = Extract<Act, { kind: "run" }>;

// [LAW:types-are-the-program] A launch takes the authenticated arguments.
// The renderer's request carries the current declaration and capture index.
export type RunAct = Omit<RequestedRun, "declaration" | "capture"> & {
  readonly program: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

// [LAW:single-enforcer] A run can outlive its click only after the host
// has verified the captured bytes against the current declaration.
export function authorizeRun(
  signer: Pick<LinkSigner, "verify">,
  pending: RequestedRun,
  captures: readonly RunEvidence[],
): Asked<RunAct> {
  const { declaration: _declaration, capture, ...request } = pending;
  const { action, session } = request;
  const evidence = captures[capture];
  if (
    evidence === undefined ||
    evidence.session !== session ||
    evidence.action !== action
  ) {
    return { kind: "failed", reason: "the click did not capture this run" };
  }
  const { evaluated, mac } = evidence;
  let verified: boolean;
  try {
    verified = signer.verify(runLinkFields(pending, evaluated), mac);
  } catch (error) {
    return { kind: "failed", reason: failureOf(error).message };
  }
  if (!verified)
    return {
      kind: "failed",
      reason:
        "the link's signature does not match what it carries: it was not drawn by this daemon, or its action has been edited since it was drawn",
    };

  let drawn: unknown;
  try {
    drawn = JSON.parse(evaluated);
  } catch {
    return {
      kind: "failed",
      reason: `run ${action}: what the link carries is not JSON`,
    };
  }
  // [LAW:parse-dont-validate] Decode the authenticated wire value into the
  // invocation the launch edge actually takes.
  if (
    drawn === null ||
    typeof drawn !== "object" ||
    !("run" in drawn) ||
    !("env" in drawn) ||
    !Array.isArray(drawn.run) ||
    drawn.env === null ||
    typeof drawn.env !== "object" ||
    Array.isArray(drawn.env)
  ) {
    return {
      kind: "failed",
      reason: `run ${action}: malformed arguments or environment`,
    };
  }
  const argv: readonly unknown[] = drawn.run;
  const env: Array<[string, unknown]> = Object.entries(drawn.env);
  const stringPair = (item: [string, unknown]): item is [string, string] =>
    typeof item[1] === "string";
  if (!argv.every((arg) => typeof arg === "string") || !env.every(stringPair))
    return {
      kind: "failed",
      reason: `run ${action}: malformed arguments or environment`,
    };
  const [program, ...args] = argv;
  if (program === undefined || program === "")
    return {
      kind: "failed",
      reason: `run ${action}: the program evaluated to nothing`,
    };
  return {
    kind: "ok",
    value: { ...request, program, args, env: Object.fromEntries(env) },
  };
}
