// [LAW:no-ambient-temporal-coupling] Jest owns each file's runtime, so its
// environment releases the fixtures that runtime created after the final hook.
const { TestEnvironment } = require("jest-environment-node");

class FixtureEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.fixtureReleases = [];
    this.global.releaseTestFixture = (release) => this.fixtureReleases.push(release);
  }

  // [LAW:no-ambient-temporal-coupling] The sandbox is per file, and this runs
  // after its last test and hook, where an `afterAll` would run before the
  // file's own: its fixtures end here, and the sandbox goes even when one fails.
  async teardown() {
    try {
      await Promise.all(this.fixtureReleases.map((release) => release()));
    } finally {
      await super.teardown();
    }
  }
}

module.exports = FixtureEnvironment;
