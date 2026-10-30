# Colour audits

Every file here walks the whole bundled theme registry: every theme, under
the variations, dial positions and styles a user can pick, at every colour
depth a terminal draws. They prove the shipped registry holds what the colour model
promises (every background a colour its theme names, text off its cell,
closed neighbours off each other) on every terminal. Each takes far longer
than any test in the suite, minutes for the registry walk, which is why they
are audits and not tests.

The rule, enforced by `audits/jest.config.js`:

- They run on the nightly GitHub schedule (`.github/workflows/colour-audits.yml`) and nowhere else.
- Never locally. `pnpm test` does not see this directory, and the audit runner refuses to start outside a scheduled run.
- Never on a pull request, never on a push to main, never by hand: the workflow has no `push`, `pull_request` or `workflow_dispatch` trigger.
- Nothing is gated on them. A red nightly run is a report to read the next morning, not a check a merge waits on.

A failing audit names the theme, look and depth it found short, so the fix
starts from the line it prints.
