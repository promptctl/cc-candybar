// Messages as the diagnostic list's tests build them: each about its own
// text, unless a test says otherwise.

import { aboutText } from "../../src/config/about";
import {
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

// The words of advisories a load earned, for a test that asks what a load said
// and not what it is about.
export const messagesOf = (
  advisories: readonly { readonly message: string }[],
): string[] => advisories.map(({ message }) => message);
