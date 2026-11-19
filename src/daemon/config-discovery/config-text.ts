import type { BigIntStats } from "node:fs";
import { identityKey } from "../../utils/folder-identity.js";
import { withRegularTextFile } from "../../utils/regular-text.js";

const MAX_ENTRIES = 256;
const MAX_BYTES = 4 * 1024 * 1024;

function revision(stat: BigIntStats): string {
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

interface Entry {
  readonly revision: string;
  readonly text: string;
  readonly bytes: number;
}

// [LAW:one-source-of-truth] One retained text per opened physical file. The
// descriptor supplies both the revision and the bytes, with no lifetime
// attached to a renderer, origin, or spelling of the path.
export class ConfigText {
  private readonly held = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly open = withRegularTextFile) {}

  read(file: string): string {
    return this.open(file, (opened) => {
      const key = identityKey(opened.observed);
      const version = revision(opened.observed);
      const held = this.held.get(key);
      if (held !== undefined) {
        this.held.delete(key);
        if (held.revision === version) {
          this.held.set(key, held);
          return held.text;
        }
        this.bytes -= held.bytes;
      }
      const text = opened.text();
      // [LAW:carrying-cost] UTF-16 size bounds the retained string even for
      // text with lossy UTF-8 decoding. Large files still load normally.
      const bytes = text.length * 2;
      // [LAW:no-ambient-temporal-coupling] A read that straddles a write
      // answers its caller without supplying bytes for a later observation.
      if (bytes <= MAX_BYTES && revision(opened.stat()) === version) {
        this.held.set(key, { revision: version, text, bytes });
        this.bytes += bytes;
        for (const [oldest, entry] of this.held) {
          if (this.held.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break;
          this.held.delete(oldest);
          this.bytes -= entry.bytes;
        }
      }
      return text;
    });
  }

  clear(): void {
    this.held.clear();
    this.bytes = 0;
  }
}
