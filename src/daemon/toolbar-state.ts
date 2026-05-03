// [LAW:one-source-of-truth] The daemon's in-memory toolbar state is the
// authoritative source for which sessions have expanded toolbars. The file at
// ~/.claude/.toolbar-state/<sessionId> is a persistence mechanism; the daemon
// reads it on cold start but owns mutations from then on.

export interface ToolbarStateReader {
  isExpanded(sessionId: string): boolean;
}

export class ToolbarState implements ToolbarStateReader {
  private expanded = new Set<string>();

  isExpanded(sessionId: string): boolean {
    return this.expanded.has(sessionId);
  }

  toggle(sessionId: string): void {
    if (this.expanded.has(sessionId)) {
      this.expanded.delete(sessionId);
    } else {
      this.expanded.add(sessionId);
    }
  }

  get size(): number {
    return this.expanded.size;
  }
}
