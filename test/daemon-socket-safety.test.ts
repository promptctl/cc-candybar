import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ensureSocketParentSafe } from "../src/daemon/paths";

function freshDir(): string {
  return path.join(os.tmpdir(), `cc-candybar-safety-${crypto.randomUUID()}`);
}

describe("ensureSocketParentSafe", () => {
  // [LAW:single-enforcer] The daemon refuses to bind in any directory it cannot
  // prove is its own. These tests assert the precondition is total — every
  // unsafe state is rejected, not just the convenient ones.

  it("creates the parent dir with mode 0700 when absent", () => {
    const dir = freshDir();
    const sock = path.join(dir, "socket");
    ensureSocketParentSafe(sock);
    const st = fs.lstatSync(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    fs.rmSync(dir, { recursive: true });
  });

  it("accepts a pre-existing parent dir with correct owner + 0700", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o700 });
    const sock = path.join(dir, "socket");
    expect(() => ensureSocketParentSafe(sock)).not.toThrow();
    fs.rmSync(dir, { recursive: true });
  });

  it("refuses a parent dir with world/group bits set", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o755 });
    fs.chmodSync(dir, 0o755); // override umask
    const sock = path.join(dir, "socket");
    expect(() => ensureSocketParentSafe(sock)).toThrow(/unsafe permissions/);
    fs.rmSync(dir, { recursive: true });
  });

  it("refuses a parent dir with only group bits set (mode 0750)", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.chmodSync(dir, 0o750);
    const sock = path.join(dir, "socket");
    expect(() => ensureSocketParentSafe(sock)).toThrow(/unsafe permissions/);
    fs.rmSync(dir, { recursive: true });
  });

  it("refuses when the parent path is a symlink", () => {
    const real = freshDir();
    fs.mkdirSync(real, { mode: 0o700 });
    const link = freshDir();
    fs.symlinkSync(real, link);
    const sock = path.join(link, "socket");
    expect(() => ensureSocketParentSafe(sock)).toThrow(/symlink/);
    fs.unlinkSync(link);
    fs.rmSync(real, { recursive: true });
  });

  it("refuses when the socket path itself is a symlink", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o700 });
    const target = path.join(dir, "real-target");
    fs.writeFileSync(target, "");
    const sock = path.join(dir, "socket");
    fs.symlinkSync(target, sock);
    expect(() => ensureSocketParentSafe(sock)).toThrow(/socket path is a symlink/);
    fs.rmSync(dir, { recursive: true });
  });

  it("succeeds when the socket path does not yet exist", () => {
    const dir = freshDir();
    fs.mkdirSync(dir, { mode: 0o700 });
    const sock = path.join(dir, "socket");
    expect(fs.existsSync(sock)).toBe(false);
    expect(() => ensureSocketParentSafe(sock)).not.toThrow();
    fs.rmSync(dir, { recursive: true });
  });
});
