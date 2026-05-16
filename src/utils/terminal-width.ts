import { launchSync } from "../proc/launch";

const VALID_TTY_PATTERN = /^[a-zA-Z0-9/]+$/;

// kz8.4 will eliminate this entire fanout. Until then every spawn is tagged
// `terminal-width` so its per-render cost is visible in daemon-stats.

function findParentTty(): string | null {
  if (process.platform === "win32") return null;

  let pid = process.pid.toString();

  for (let i = 0; i < 10; i++) {
    const r = launchSync({
      bin: "ps",
      args: ["-o", "ppid=,tty=", "-p", pid],
      category: "terminal-width",
    });
    if (!r.ok) break;
    const parts = r.stdout.trim().split(/\s+/);
    const ppid = parts[0];
    const tty = parts[1];

    if (tty && tty !== "?" && tty !== "??" && VALID_TTY_PATTERN.test(tty)) {
      return tty;
    }

    if (!ppid || ppid === "1" || ppid === "0") break;
    pid = ppid;
  }

  return null;
}

function getWindowsTerminalWidth(): number | null {
  const r = launchSync({
    bin: "mode",
    args: ["con"],
    category: "terminal-width",
  });
  if (!r.ok) return null;
  const match = r.stdout.match(/Columns:\s*(\d+)/i);
  if (match?.[1]) {
    const parsed = parseInt(match[1], 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function getUnixTerminalWidth(): number | null {
  const tty = findParentTty();
  if (tty) {
    const r = launchSync({
      bin: "/bin/sh",
      args: ["-c", `stty size < /dev/${tty}`],
      category: "terminal-width",
    });
    if (r.ok) {
      const width = r.stdout.trim().split(" ")[1];
      if (width) {
        const parsed = parseInt(width, 10);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    }
  }

  const r = launchSync({
    bin: "tput",
    args: ["cols"],
    category: "terminal-width",
  });
  if (r.ok) {
    const parsed = parseInt(r.stdout.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}

/**
 * @info Reserves characters for Claude Code's right-side UI messages
 * (e.g., "Current: 2.1.78 · latest: 2.1.78", "Thinking off")
 */
const RESERVED_CHARS = 45;

export function getTerminalWidth(): number | null {
  const applyReserve = (w: number) => Math.max(1, w - RESERVED_CHARS);

  const envColumns = process.env.COLUMNS;
  if (envColumns) {
    const parsed = parseInt(envColumns, 10);
    if (!isNaN(parsed) && parsed > 0) return applyReserve(parsed);
  }

  if (process.stdout.columns && process.stdout.columns > 0) {
    return applyReserve(process.stdout.columns);
  }

  if (process.platform === "win32") {
    const width = getWindowsTerminalWidth();
    if (width) return applyReserve(width);
  }

  const width = getUnixTerminalWidth();
  return width ? applyReserve(width) : null;
}

export function getRawTerminalWidth(): number | null {
  // Skip COLUMNS env and process.stdout.columns — Claude Code sets those
  // to an already-reserved panel width. We need the actual terminal width
  // so the grid engine can apply its own widthReserve.
  if (process.platform === "win32") {
    return getWindowsTerminalWidth();
  }

  return getUnixTerminalWidth();
}
