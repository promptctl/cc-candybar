import type { Release } from "./holds";

// [LAW:single-enforcer] The one way an owner tells whoever subscribed: in
// subscription order, over the set as the telling began, so a listener that
// subscribes or leaves while it is told changes the next telling, never this
// one.
export class Listeners<Notice> {
  private readonly listening = new Set<(notice: Notice) => void>();

  subscribe(listener: (notice: Notice) => void): Release {
    this.listening.add(listener);
    return () => void this.listening.delete(listener);
  }

  tell(notice: Notice): void {
    for (const listener of [...this.listening]) listener(notice);
  }

  clear(): void {
    this.listening.clear();
  }
}
