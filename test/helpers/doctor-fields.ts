// Each of the doctor's field groups as the record's one writer spells it, for a
// test that reads the line a log reader sees, quoting included.

import * as report from "../../src/doctor/report";
import { eventLine, type Field } from "../../src/utils/logfmt";

const spelled =
  <A extends unknown[]>(fields: (...args: A) => readonly Field[]) =>
  (...args: A): string =>
    eventLine("", fields(...args)).trimStart();

export const configFields = spelled(report.configFields);
export const linkFields = spelled(report.linkFields);
export const terminalFeatureFields = spelled(report.terminalFeatureFields);
export const installFields = spelled(report.installFields);
export const daemonFields = spelled(report.daemonFields);
export const dataFields = spelled(report.dataFields);
export const frameFields = spelled(report.frameFields);
export const truecolorEnvFields = spelled(report.truecolorEnvFields);
export const transcriptFields = spelled(report.transcriptFields);
export const nerdFontFields = spelled(report.nerdFontFields);
