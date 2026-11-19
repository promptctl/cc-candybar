import type { ThemeName } from "@promptctl/rich-js";
import { isInstalledTheme } from "../../src/themes/policy";

// A name a test read off a drawn bar or a domain, proven an installed theme.
export function installedTheme(name: string): ThemeName {
  if (!isInstalledTheme(name)) throw new Error(`"${name}" is no installed theme`);
  return name;
}
