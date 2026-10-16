// [LAW:no-silent-failure] A probe the launch rate limit refused is not a fact
// about the system — it is the doctor declining to look twice inside a
// second. It is thrown, never folded into the facts: a refused tmux query
// would otherwise read as a terminal tmux could not name, and a mark made on
// it would be filed under that. The verbs refuse the click with its message.
export class DoctorBusy extends Error {
  constructor(what: string) {
    super(`the doctor looked at ${what} less than a second ago — click again`);
    this.name = "DoctorBusy";
  }
}
