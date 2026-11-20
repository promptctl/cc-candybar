import { observable, runInAction } from "mobx";
import { valueOf } from "../../utils/logfmt";
import type { Failure } from "./verb-error";

// [LAW:types-are-the-program] A unit of work between the disk and the bar,
// as a defect names it: its kind, which one it is, and how a reader knows it.
export interface DefectUnit {
  readonly kind: "git refresh" | "config discovery" | "watch delivery";
  readonly key: string;
  readonly about: string;
}

// A unit whose last run threw, and the message it threw.
export interface Defect extends DefectUnit {
  readonly message: string;
}

// [LAW:single-enforcer] The one record of the daemon's defects. Every failure
// these units expect is already a value, so a throw is a defect of the
// daemon: the boundary where a unit starts settles it here, and it stands
// until the unit's next run returns or its owner ends it. Observable, so the
// daemon's facts derive from it and no listener runs inside the commit of
// whoever settled it; MobX keeps a reaction's own throw to itself.
export class Defects {
  private readonly standing = observable.map<string, Defect>(undefined, {
    deep: false,
  });

  constructor(
    private readonly log: (level: "info" | "error", message: string) => void,
  ) {}

  // How a unit's run ended: the failure it threw, or null once it returned
  // or its owner ended it. [LAW:nothing-unseen] Logged as a defect starts,
  // as its message changes and as it clears, never once per run.
  settle(unit: DefectUnit, failure: Failure | null): void {
    const id = `${unit.kind}\0${unit.key}`;
    const was = this.standing.get(id);
    if (was?.message === failure?.message) return;
    const fields = `kind=${valueOf(unit.kind)} about=${valueOf(unit.about)}`;
    if (failure === null) this.log("info", `defect cleared ${fields}`);
    else
      this.log(
        "error",
        `defect ${fields} failed=${valueOf(failure.message)} detail=${valueOf(failure.detail)}`,
      );
    runInAction(() =>
      failure === null
        ? this.standing.delete(id)
        : this.standing.set(id, { ...unit, message: failure.message }),
    );
  }

  list(): readonly Defect[] {
    return [...this.standing.values()];
  }
}
