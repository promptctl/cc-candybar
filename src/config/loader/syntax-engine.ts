import { createEngine } from "@promptctl/go-template-js";

// [LAW:one-source-of-truth] The loader's one parse-only engine. Parsing looks
// no function up, so it carries no FuncMap: it checks a template's syntax and
// reads its AST, and never evaluates.
export const SYNTAX_ENGINE = createEngine<string>({ fromString: (s) => s });
