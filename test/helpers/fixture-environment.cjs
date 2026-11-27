// [LAW:no-ambient-temporal-coupling] Jest owns each file's runtime, so its
// environment releases the fixtures that runtime created after the final hook.
const path = require("node:path");
const { trackFilePeriods } = require("./file-periods.cjs");
const { TestEnvironment } = require("jest-environment-node");

class FixtureEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.checkPeriods = trackFilePeriods(
      this.global,
      path.relative(config.projectConfig.rootDir, context.testPath),
      context.testPath,
    );
    this.fixtureReleases = [];
    this.global.releaseTestFixture = (release) =>
      this.fixtureReleases.push(release);
  }

  // [LAW:no-ambient-temporal-coupling] The sandbox is per file, and this runs
  // after its last test and hook, where an `afterAll` would run before the
  // file's own: its fixtures end here, and the sandbox goes even when one fails.
  async teardown() {
    const releases = await Promise.allSettled(
      this.fixtureReleases.map((release) => Promise.resolve().then(release)),
    );
    const failures = releases
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    for (const finish of [this.checkPeriods, () => super.teardown()]) {
      try {
        await finish();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        failures.map((error) => error?.stack ?? String(error)).join("\n"),
      );
    }
  }
}

module.exports = FixtureEnvironment;
