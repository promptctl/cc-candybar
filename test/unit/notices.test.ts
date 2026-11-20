// The daemon's one channel to every bar (src/daemon/notices.ts): a notice
// joins the unanswered one about the same thing, an answer marks what it
// carried, and a notice past its hold leaves when another arrives.

import { Notices, type Notification } from "../../src/daemon/notices";
import { isEnvironmentOutput } from "../../src/daemon/environment-output";
import { DAEMON_EVENT_HOLD_S } from "../../src/utils/event-hold";
import type { Instant } from "../../src/utils/instant";

const told = (about: string, text: string): Notification => ({
  level: "error",
  about,
  text,
  fromEnvironment: false,
});

function channel() {
  let now = 100;
  const notices = new Notices(() => now as Instant);
  return {
    notices,
    later: (seconds: number) => void (now += seconds),
  };
}

test("a notice joins the unanswered one about the same thing, and a repeat of its words moves nothing", () => {
  const { notices } = channel();
  expect(notices.notify(told("git", "refresh threw"))).toBe(true);
  expect(notices.notify(told("git", "refresh threw"))).toBe(false);
  expect(notices.notify(told("git", "refresh"))).toBe(true);
  expect(notices.notify(told("watch", "refresh threw"))).toBe(true);
  expect(notices.list()).toEqual([
    expect.objectContaining({
      level: "error",
      about: "git",
      text: "refresh threw\nrefresh",
      revision: 2,
    }),
    expect.objectContaining({ about: "watch", revision: 1 }),
  ]);
});

test("an answer marks the notice it carried, and the next one starts afresh", () => {
  const { notices } = channel();
  notices.notify(told("git", "refresh threw"));
  const shown = notices.list();
  notices.notify(told("git", "lookup threw"));
  expect(notices.answered(shown)).toBe(false);
  expect(notices.answered(notices.list())).toBe(true);
  expect(notices.answered(notices.list())).toBe(false);
  expect(notices.notify(told("git", "refresh threw"))).toBe(true);
  expect(notices.list()).toEqual([
    expect.objectContaining({ text: "refresh threw", answered: false }),
  ]);
});

test("an answered notice past its hold leaves when another arrives; an unanswered one stays owed", () => {
  const { notices, later } = channel();
  notices.notify(told("answered", "seen"));
  notices.answered(notices.list());
  notices.notify(told("owed", "unseen"));
  later(DAEMON_EVENT_HOLD_S + 1);
  notices.notify(told("new", "now"));
  expect(notices.list().map((notice) => notice.about)).toEqual(["owed", "new"]);
});

test("a notice from a session's environment stays marked while it is joined", () => {
  const { notices } = channel();
  notices.notify({ ...told("act", "printed"), fromEnvironment: true });
  notices.notify(told("act", "failed"));
  expect(isEnvironmentOutput(notices.list()[0]!)).toBe(true);
  notices.answered(notices.list());
  notices.notify(told("act", "failed again"));
  expect(isEnvironmentOutput(notices.list()[0]!)).toBe(false);
});
