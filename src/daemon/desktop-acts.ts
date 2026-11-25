import type { DesktopClickId } from "../renderer-interface/click-arrival.js";
import type { DesktopAct } from "../renderer-interface/interface.js";

// [LAW:one-source-of-truth] The copy and open acts of the clicks whose acts
// the desktop the person sits at carries out: a bar drawn over ssh, whose
// click the URL handler on the person's machine waits on. An act belongs to
// the click that asked it, by the id that click carries from its arrival, so
// it reaches that click's verdict whichever turn of the renderer asks it and
// whichever click's landing settles it.
export class DesktopActs {
  private readonly held = new Map<DesktopClickId, DesktopAct[]>();
  private issued = 0;

  // A click starts holding its acts as it is handed to the renderer.
  begin(): DesktopClickId {
    const click = `desktop-click-${++this.issued}` as DesktopClickId;
    this.held.set(click, []);
    return click;
  }

  // Whether the click still held its place for the act: one that has already
  // been answered has no verdict left to carry it.
  deposit(click: DesktopClickId, act: DesktopAct): boolean {
    const acts = this.held.get(click);
    if (acts === undefined) return false;
    acts.push(act);
    return true;
  }

  // The click's acts in the order asked, once its landing is over.
  end(click: DesktopClickId): readonly DesktopAct[] {
    const acts = this.held.get(click);
    if (acts === undefined)
      throw new Error(`${click} ended twice, or never began`);
    this.held.delete(click);
    return acts;
  }
}
