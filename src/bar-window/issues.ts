// A native hide acknowledges presentation. Only the next tmux layout result
// can retire a placement failure. Publish the current user-facing reason once.
export class WindowIssues {
  private layout = "";
  private surface = "";
  private shown?: string;
  constructor(private readonly publish: (reason: string) => void) {}

  setLayout(reason: string): void {
    this.layout = reason;
    this.update();
  }
  setSurface(reason: string): void {
    this.surface = reason;
    this.update();
  }

  private update(): void {
    const reason = this.layout || this.surface;
    if (reason !== this.shown) {
      this.shown = reason;
      this.publish(reason);
    }
  }
}
