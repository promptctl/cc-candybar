import { identityKey } from "../../utils/folder-identity.js";
import { withRegularTextFile } from "../../utils/regular-text.js";
import { polledEntryOf } from "../foundations/polled-entry.js";

const MAX_ENTRIES = 256;
const MAX_BYTES = 4 * 1024 * 1024;

interface ObservedText {
  readonly entry: string;
  readonly text: string;
}

interface Entry extends ObservedText {
  readonly bytes: number;
}

// [LAW:one-source-of-truth] One retained text per opened physical file. The
// descriptor supplies both the revision and the bytes, with no lifetime
// attached to a renderer, origin, or spelling of the path.
export class ConfigText {
  private readonly held = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly open = withRegularTextFile) {}

  read(file: string): ObservedText {
    return this.open(file, (opened) => {
      const key = identityKey(opened.observed);
      const entry = polledEntryOf(opened.observed);
      const held = this.held.get(key);
      if (held !== undefined) {
        this.held.delete(key);
        if (held.entry === entry) {
          this.held.set(key, held);
          return held;
        }
        this.bytes -= held.bytes;
      }
      const text = opened.text();
      // [LAW:carrying-cost] UTF-16 size bounds the retained string even for
      // text with lossy UTF-8 decoding. Large files still load normally.
      const bytes = text.length * 2;
      // [LAW:no-ambient-temporal-coupling] A read that straddles a write
      // answers its caller without supplying bytes for a later observation.
      if (bytes <= MAX_BYTES && polledEntryOf(opened.stat()) === entry) {
        this.held.set(key, { entry, text, bytes });
        this.bytes += bytes;
        for (const [oldest, entry] of this.held) {
          if (this.held.size <= MAX_ENTRIES && this.bytes <= MAX_BYTES) break;
          this.held.delete(oldest);
          this.bytes -= entry.bytes;
        }
      }
      return { entry, text };
    });
  }

  clear(): void {
    this.held.clear();
    this.bytes = 0;
  }
}
