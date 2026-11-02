#!/usr/bin/env node
// PreToolUse hook: agent sessions in this repo may not take down the 1.x release
// pin (scripts/major-guard.mjs). It refuses edits to the guard and to this hook's
// own wiring, and any `gh api` call that writes a ruleset, save a PUT of
// `main-protection` (the `v1-only-tags` ruleset is the pin's GitHub-side lock).
// Only Brandon lifts the pin.
import { readFileSync } from "node:fs";

const PINNED_FILES = ["scripts/major-guard.mjs", ".claude/hooks/release-pin.mjs", ".claude/settings.json"];

// The branch ruleset, whose required checks follow the CI jobs agents rename.
const MAIN_PROTECTION = "rulesets/16499426";

const { tool_name: tool, tool_input: input = {} } = JSON.parse(readFileSync(0, "utf8"));

function refusalOf() {
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const path = input.file_path ?? input.notebook_path ?? "";
    const hit = PINNED_FILES.find((f) => path.endsWith(`/${f}`));
    return hit && `${hit} holds the 1.x release pin`;
  }
  if (tool === "Bash") {
    const cmd = input.command ?? "";
    if (PINNED_FILES.some((f) => cmd.includes(f)) && !/^\s*(cat|less|head|tail|grep|rg|git (diff|log|show|status))\b/.test(cmd)) {
      return "the command touches a file that holds the 1.x release pin";
    }
    const rulesets = cmd.match(/rulesets(?:\/\d+)?/g) ?? [];
    const write = /(?:-X|--method)[\s=]*(DELETE|PUT|PATCH|POST)/i.exec(cmd);
    if (rulesets.length > 0 && write && !(write[1].toUpperCase() === "PUT" && rulesets.every((r) => r === MAIN_PROTECTION))) {
      return "the command writes the repo's rulesets, which hold the 1.x tag lock";
    }
  }
  return null;
}

const refusal = refusalOf();
if (refusal) {
  console.error(`release-pin: refused — ${refusal}. This project stays on 1.x until Brandon explicitly says otherwise; tell him what you needed instead.`);
  process.exit(2);
}
