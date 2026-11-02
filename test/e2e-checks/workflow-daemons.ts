import { posix } from "node:path";

import ts from "typescript";
import { parse as parseYaml } from "yaml";

// [LAW:single-enforcer] No CI step starts a daemon outside the five end-to-end
// tests. The start judge sees jest only, so a script a workflow runs is judged
// here: a step fails when the script it reaches, followed through package.json
// and the script's relative imports, imports `daemonArgs` or `createDaemon`.
// Jest runs stay the judge's and are skipped. This core reads nothing itself:
// the workflows are text and the repository is a `Repo`, so its tests touch no disk.
// [LAW:effects-at-boundaries]

/** The symbols whose import means a module can start a daemon. */
export const DAEMON_SYMBOLS: ReadonlySet<string> = new Set(["daemonArgs", "createDaemon"]);

export interface Repo {
  /** package.json `scripts`. */
  scripts: Readonly<Record<string, string>>;
  /** A file's text by repo-relative posix path, or undefined when the repo has none. */
  read(path: string): string | undefined;
}

export interface Step {
  run: string;
  condition: string | undefined;
}

export interface Violation {
  workflow: string;
  step: string;
  /** The module the step reaches that imports a daemon symbol. */
  offender: string;
}

/** Every `run:` step of a workflow, with its `if:`. Fails on a shape that is not a workflow. */
export function stepsOf(workflowText: string, source: string): Step[] {
  const doc: unknown = parseYaml(workflowText);
  const jobs = (doc as { jobs?: unknown } | null)?.jobs;
  if (jobs === null || typeof jobs !== "object") {
    throw new Error(`${source}: a workflow needs a jobs mapping`);
  }
  return Object.entries(jobs).flatMap(([job, body]) => {
    const steps = (body as { steps?: unknown } | null)?.steps;
    if (steps === undefined) return []; // a job that calls a reusable workflow has no steps
    if (!Array.isArray(steps)) throw new Error(`${source}: job ${job} has steps that are not a list`);
    return steps.flatMap((step: { run?: unknown; if?: unknown }) =>
      typeof step.run === "string"
        ? [{ run: step.run, condition: typeof step.if === "string" ? step.if : undefined }]
        : [],
    );
  });
}

/** A shell script's commands as token lists, split on `&&`, `||`, `;`, `|` and newlines. */
export function commandsOf(script: string): string[][] {
  return script
    .replace(/\\\n/g, " ")
    .split(/&&|\|\||;|\||\n/)
    .map((part) => part.trim().split(/\s+/).map(unquote).filter((token) => token !== ""))
    .filter((tokens) => tokens.length > 0);
}

function unquote(token: string): string {
  return token.replace(/^["']|["']$/g, "");
}

/**
 * The commands a `run:` text executes once package scripts are expanded: `pnpm
 * run X`, `pnpm X` and `npm run X` become the commands of script X. A script that
 * names itself is expanded once.
 */
export function leafCommands(run: string, repo: Repo, expanding: ReadonlySet<string> = new Set()): string[][] {
  return commandsOf(run).flatMap((tokens) => {
    const script = packageScriptOf(tokens, repo);
    if (script === undefined) return [tokens];
    if (expanding.has(script)) return [];
    return leafCommands(repo.scripts[script]!, repo, new Set([...expanding, script]));
  });
}

function packageScriptOf(tokens: string[], repo: Repo): string | undefined {
  const [runner, verb, name] = tokens;
  if (runner !== "pnpm" && runner !== "npm" && runner !== "yarn") return undefined;
  const candidate = verb === "run" ? name : verb;
  return candidate !== undefined && Object.hasOwn(repo.scripts, candidate) ? candidate : undefined;
}

export function isJest(tokens: string[]): boolean {
  const [head, second, third] = tokens;
  return head === "jest" || (head === "npx" && second === "jest") || (head === "pnpm" && second === "exec" && third === "jest");
}

/** The value of jest's `--config`, in either spelling. */
export function jestConfigOf(tokens: string[]): string | undefined {
  const at = tokens.findIndex((token) => token === "--config" || token.startsWith("--config="));
  if (at === -1) return undefined;
  return tokens[at]!.startsWith("--config=") ? tokens[at]!.slice("--config=".length) : tokens[at + 1];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** The files a command names as arguments that the repo holds: the scripts `node` and `tsx` run. */
function entryFilesOf(tokens: string[], repo: Repo): string[] {
  return tokens
    .map((token) => posix.normalize(token))
    .filter((path) => SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) && repo.read(path) !== undefined);
}

function resolveImport(from: string, specifier: string, repo: Repo): string | undefined {
  if (!specifier.startsWith(".")) return undefined; // a package, not repo source
  const base = posix.join(posix.dirname(from), specifier);
  const swapped = base.replace(/\.(m|c)?js$/, (_m, flavour: string | undefined) => `.${flavour ?? ""}ts`);
  const candidates = [
    base,
    swapped,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => posix.join(base, `index${ext}`)),
  ];
  return candidates.find((path) => repo.read(path) !== undefined);
}

function sourceFileOf(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** Whether a module imports, or re-exports from elsewhere, a symbol that starts a daemon. */
export function importsDaemonSymbol(path: string, text: string): boolean {
  return sourceFileOf(path, text).statements.some((statement) => {
    const names =
      ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined && ts.isNamedImports(statement.importClause.namedBindings)
        ? statement.importClause.namedBindings.elements
        : ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : [];
    return names.some((element) => DAEMON_SYMBOLS.has((element.propertyName ?? element.name).text));
  });
}

/** The first module reachable from `entry` through relative imports that imports a daemon symbol. */
export function daemonImporterReachedFrom(entry: string, repo: Repo): string | undefined {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = repo.read(path)!;
    if (importsDaemonSymbol(path, text)) return path;
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      const next = resolveImport(path, fileName, repo);
      if (next !== undefined) queue.push(next);
    }
  }
  return undefined;
}

/**
 * The steps of the given workflows that reach a module importing a daemon
 * symbol. A workflow named in `excused` is skipped whole.
 */
export function violationsOf(
  workflows: readonly { name: string; text: string }[],
  repo: Repo,
  excused: readonly string[],
): Violation[] {
  return workflows
    .filter((workflow) => !excused.includes(workflow.name))
    .flatMap((workflow) =>
      stepsOf(workflow.text, workflow.name).flatMap((step) =>
        leafCommands(step.run, repo)
          .filter((tokens) => !isJest(tokens))
          .flatMap((tokens) => entryFilesOf(tokens, repo))
          .flatMap((entry) => {
            const offender = daemonImporterReachedFrom(entry, repo);
            return offender === undefined
              ? []
              : [{ workflow: workflow.name, step: step.run.trim().split("\n")[0]!, offender }];
          }),
      ),
    );
}
