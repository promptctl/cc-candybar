// Messages as the diagnostic list's tests build them: each about its own
// text, unless a test says otherwise.

import {
  aboutText,
  diagnosticSpan,
  type DiagnosticMessage,
  type DiagnosticSeverity,
} from "../../src/render/diagnostics";

export const sourced = (text: string) => ({
  about: aboutText("test", text),
  text,
  copy: text,
});

export const shaped = (
  severity: DiagnosticSeverity,
  text: string,
): DiagnosticMessage => ({
  severity,
  about: aboutText("test", text),
  message: text,
  copy: text,
  lines: [[diagnosticSpan(text, null)]],
});
