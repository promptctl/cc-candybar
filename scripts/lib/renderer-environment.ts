// [LAW:single-enforcer] Inspect the JavaScript that both engines execute.
// Package sources may also contain host APIs removed by production tree shaking.
import { SourceMap } from "node:module";
import { Linter, type Rule } from "eslint";
import {
  getStaticValue,
  findVariable,
  getPropertyName,
  ReferenceTracker,
} from "@eslint-community/eslint-utils";

const { READ, CALL, CONSTRUCT } = ReferenceTracker;
const forbidden = { [READ]: "ambient" } as const;
const regional = { [CALL]: "locale", [CONSTRUCT]: "locale" } as const;
const localDateMethods = [
  "getFullYear",
  "getYear",
  "getMonth",
  "getDate",
  "getDay",
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getTimezoneOffset",
  "setFullYear",
  "setYear",
  "setMonth",
  "setDate",
  "setHours",
  "setMinutes",
  "setSeconds",
  "setMilliseconds",
  "toDateString",
  "toTimeString",
  "toString",
  "toLocaleString",
  "toLocaleDateString",
  "toLocaleTimeString",
];
const dateProjection = Object.fromEntries(
  localDateMethods.map((name) => [name, forbidden]),
);
const capabilities = {
  Date: {
    [CALL]: "ambient",
    [CONSTRUCT]: "instant",
    now: forbidden,
    parse: { [CALL]: "parse" },
    prototype: dateProjection,
  },
  Math: { random: forbidden },
  performance: forbidden,
  requestAnimationFrame: forbidden,
  Temporal: { Now: forbidden },
  crypto: { randomUUID: forbidden, getRandomValues: forbidden },
  process: forbidden,
  navigator: forbidden,
  Intl: {
    // Even a named locale and zone consult engine-specific ICU/tzdata.
    // Peers consume the recorded integer presentation and pinned calendar.
    DateTimeFormat: forbidden,
    NumberFormat: forbidden,
    Segmenter: forbidden,
    Collator: regional,
    DisplayNames: regional,
    ListFormat: regional,
    PluralRules: regional,
    RelativeTimeFormat: regional,
    DurationFormat: regional,
  },
} as const;

type Argument = Extract<
  Rule.Node,
  { type: "CallExpression" }
>["arguments"][number];

function missing(arg: Argument | undefined): boolean {
  return (
    !arg ||
    (arg.type === "Identifier" && arg.name === "undefined") ||
    (arg.type === "UnaryExpression" && arg.operator === "void")
  );
}

// ECMAScript interprets ISO date-only forms in UTC. Time-bearing forms
// need an explicit offset. Legacy text belongs to the regional parser.
function absoluteISO(text: string): boolean {
  // Only the portable ECMAScript grammar. V8 normalizes February 31 and
  // accepts negative-zero years through its unrelated legacy parser.
  const match =
    /^((?!-000000)[+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(
      text,
    );
  if (!match || !Number.isFinite(Date.parse(text))) return false;
  const month = Number(match[2] ?? 1),
    day = Number(match[3] ?? 1);
  const year = Number(match[1]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0);
}

type Name = Extract<Argument, { type: "Identifier" }>;
type Expr = Exclude<Argument, { type: "SpreadElement" }>;
function numericEpoch(
  node: Expr,
  context: Rule.RuleContext,
  seen = new Set<Expr>(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  switch (node.type) {
    case "Literal":
      return typeof node.value === "number";
    case "UnaryExpression":
      return ["+", "-", "~"].includes(node.operator);
    case "BinaryExpression":
      if (node.operator === "+")
        return (
          node.left.type !== "PrivateIdentifier" &&
          numericEpoch(node.left, context, seen) &&
          numericEpoch(node.right, context, seen)
        );
      return [
        "-",
        "*",
        "/",
        "%",
        "**",
        "|",
        "&",
        "^",
        "<<",
        ">>",
        ">>>",
      ].includes(node.operator);
    case "CallExpression":
      return (
        (node.callee.type === "Identifier" && node.callee.name === "Number") ||
        (node.callee.type === "MemberExpression" &&
          getPropertyName(node.callee) === "getTime")
      );
    case "Identifier": {
      const variable = findVariable(context.sourceCode.getScope(node), node);
      const def = variable?.defs[0];
      return (
        def?.type === "Variable" &&
        !!def.node.init &&
        variable!.references.every(
          (ref) => !ref.isWrite() || ref.init === true,
        ) &&
        numericEpoch(def.node.init, context, seen)
      );
    }
    default:
      return false;
  }
}

function implicitLocale(
  arg: Argument | undefined,
  context: Rule.RuleContext,
): boolean {
  if (missing(arg)) return true;
  if (!arg || arg.type === "SpreadElement") return true;
  const known = getStaticValue(arg, context.sourceCode.getScope(arg));
  return !!known && Array.isArray(known.value) && !known.value.length;
}

const rule: Rule.RuleModule = {
  create(context) {
    function reject(node: Rule.Node, name: string) {
      context.report({
        node,
        message: `Portable renderer reads ${name}; supply the recorded input`,
      });
    }
    // Follow the actual native Date through local names and function arguments.
    // A helper taking an application clock can legitimately use a homonymous method.
    const visited = new Set<Rule.Node>();
    function readsOf(id: Name) {
      const variable = findVariable(context.sourceCode.getScope(id), id);
      for (const ref of variable?.references ?? [])
        if (ref.isRead()) projectionOf(ref.identifier as Rule.Node & Name);
    }
    // The standard instant helper returns a native Date. Follow its result
    // to its consumers just as we follow a local variable holding that value.
    function returnedBy(fn: Rule.Node) {
      if (
        fn.type !== "ArrowFunctionExpression" &&
        fn.type !== "FunctionExpression" &&
        fn.type !== "FunctionDeclaration"
      )
        return;
      const parent = fn.parent;
      if (parent.type === "CallExpression" && parent.callee === fn) {
        projectionOf(parent);
        return;
      }
      const binding =
        fn.type === "FunctionDeclaration"
          ? fn.id
          : parent.type === "VariableDeclarator"
            ? parent.id
            : undefined;
      if (binding?.type !== "Identifier") return;
      const variable = findVariable(context.sourceCode.getScope(fn), binding);
      for (const ref of variable?.references ?? []) {
        const use = ref.identifier as Rule.Node & Name;
        if (use.parent.type === "CallExpression" && use.parent.callee === use)
          projectionOf(use.parent);
      }
    }
    function projectionOf(
      value: Extract<
        Rule.Node,
        { type: "NewExpression" | "CallExpression" | "Identifier" }
      >,
    ) {
      if (visited.has(value)) return;
      visited.add(value);
      const parent = value.parent;
      if (parent.type === "MemberExpression" && parent.object === value) {
        const key = getPropertyName(
          parent,
          context.sourceCode.getScope(parent),
        );
        if (key && localDateMethods.includes(key))
          reject(parent, "Date." + key);
      } else if (
        parent.type === "TemplateLiteral" ||
        (parent.type === "BinaryExpression" && parent.operator === "+")
      ) {
        reject(parent, "Date string conversion");
      } else if (
        parent.type === "VariableDeclarator" &&
        parent.id.type === "Identifier"
      ) {
        readsOf(parent.id);
      } else if (
        parent.type === "AssignmentExpression" &&
        parent.right === value &&
        parent.left.type === "Identifier"
      ) {
        readsOf(parent.left);
      } else if (
        parent.type === "ArrowFunctionExpression" &&
        parent.body === value
      ) {
        returnedBy(parent);
      } else if (parent.type === "ReturnStatement") {
        const fn = context.sourceCode
          .getAncestors(parent)
          .findLast(
            (ancestor) =>
              ancestor.type === "FunctionDeclaration" ||
              ancestor.type === "FunctionExpression" ||
              ancestor.type === "ArrowFunctionExpression",
          );
        if (fn) returnedBy(fn as Rule.Node);
      } else if (parent.type === "CallExpression") {
        const callee = parent.callee;
        if (callee.type === "Identifier" && callee.name === "String") {
          reject(parent, "Date string conversion");
          return;
        }
        const def =
          callee.type === "Identifier"
            ? findVariable(context.sourceCode.getScope(callee), callee)?.defs[0]
            : undefined;
        const fn =
          def?.type === "FunctionName"
            ? def.node
            : def?.type === "Variable"
              ? def.node.init
              : callee;
        if (
          fn?.type !== "FunctionDeclaration" &&
          fn?.type !== "FunctionExpression" &&
          fn?.type !== "ArrowFunctionExpression"
        )
          return;
        const param =
          fn.params[parent.arguments.findIndex((arg) => arg === value)];
        if (param?.type === "Identifier") readsOf(param);
      }
    }
    return {
      Program(node) {
        const tracker = new ReferenceTracker(context.sourceCode.getScope(node));
        for (const hit of tracker.iterateGlobalReferences(capabilities)) {
          const target = hit.node;
          const name = hit.path.join(".");
          if (hit.info === "ambient") {
            reject(target, name);
            continue;
          }
          if (
            target.type !== "NewExpression" &&
            target.type !== "CallExpression"
          )
            continue;
          const [first] = target.arguments;
          if (hit.info === "instant" || hit.info === "parse") {
            if (
              target.arguments.length !== 1 ||
              !first ||
              first.type === "SpreadElement"
            ) {
              reject(target, name);
              continue;
            }
            const known = getStaticValue(
              first,
              context.sourceCode.getScope(first),
            );
            if (
              typeof known?.value === "string"
                ? !absoluteISO(known.value)
                : hit.info === "parse" || !numericEpoch(first, context)
            )
              reject(target, name);
            if (hit.info === "instant") projectionOf(target);
          } else if (implicitLocale(first, context)) reject(target, name);
        }
      },
      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const name = getPropertyName(
          node.callee,
          context.sourceCode.getScope(node),
        );
        if (
          name === "localeCompare" &&
          implicitLocale(node.arguments[1], context)
        )
          reject(node, name);
        if (
          name === "toLocaleString" ||
          name === "toLocaleDateString" ||
          name === "toLocaleTimeString"
        )
          reject(node, name);
        if (
          (name === "toLocaleUpperCase" || name === "toLocaleLowerCase") &&
          implicitLocale(node.arguments[0], context)
        )
          reject(node, name);
      },
    };
  },
};

export function checkRendererEnvironment(js: string, mapText: string): void {
  const globals = Object.fromEntries(
    [
      ...Object.keys(capabilities),
      "globalThis",
      "window",
      "self",
      "global",
    ].map((name) => [name, "readonly" as const]),
  );
  const messages = new Linter().verify(js, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals },
    plugins: { renderer: { rules: { environment: rule } } },
    rules: { "renderer/environment": "error" },
  });
  if (messages.length === 0) return;
  const map = new SourceMap(JSON.parse(mapText));
  const failures = messages.map(({ line, column, message }) => {
    const origin = map.findEntry(line - 1, column - 1);
    const location =
      "originalSource" in origin
        ? `${origin.originalSource}:${origin.originalLine + 1}:${origin.originalColumn + 1}`
        : `renderer.mjs:${line}:${column}`;
    return `${location}: ${message}`;
  });
  throw new Error(failures.join("\n"));
}
