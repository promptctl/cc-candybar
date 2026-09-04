import {
  assessCurrency,
  currencyReport,
  fetchLatestVersion,
  formatVersion,
  parseReleaseVersion,
  REGISTRY_URL,
  type Currency,
} from "../src/install/currency";
import { ABSENT, failed, ok } from "../src/utils/outcome";

const PKG = "@promptctl/cc-candybar";
const DIST_TAGS_URL = `${REGISTRY_URL}/-/package/${encodeURIComponent(PKG)}/dist-tags`;

// A registry that answers `dist-tags` with the given body and status.
function registry(body: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

// A registry that cannot be reached at all.
const unreachable: typeof fetch = async () => {
  throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
};

describe("parseReleaseVersion", () => {
  test("round-trips a release triple", () => {
    expect(parseReleaseVersion("1.34.0")).toEqual(ok([1, 34, 0]));
    const parsed = parseReleaseVersion("12.0.7");
    expect(parsed.kind === "ok" && formatVersion(parsed.value)).toBe("12.0.7");
  });

  // [LAW:parse-dont-validate] Anything the ordering cannot cover is refused
  // at the border as a typed failure naming the text, not admitted with an
  // undefined comparison.
  test.each(["1.2", "v1.2.3", "1.2.3-beta.1", "01.2.3", "dev", ""])(
    "refuses %j",
    (text) => {
      expect(parseReleaseVersion(text)).toEqual(
        failed(expect.stringContaining(`"${text}" is not a release version`)),
      );
    },
  );
});

describe("fetchLatestVersion", () => {
  test("asks the registry's dist-tags endpoint, name encoded, with a timeout", async () => {
    let seen: { url: string; signal: unknown } | undefined;
    const spy: typeof fetch = async (input, init) => {
      seen = { url: String(input), signal: init?.signal };
      return new Response(JSON.stringify({ latest: "1.41.3" }));
    };
    await expect(fetchLatestVersion(PKG, spy, REGISTRY_URL)).resolves.toEqual(ok([1, 41, 3]));
    expect(seen?.url).toBe(DIST_TAGS_URL);
    expect(seen?.url).toContain("%40promptctl%2Fcc-candybar");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  // [LAW:no-silent-failure] Every way the lookup can fail to answer is a
  // `failed` carrying its reason — never a rejection that would take the
  // install down, never a value that could read as current.
  test("a refused connection is `failed` with the error text", async () => {
    await expect(fetchLatestVersion(PKG, unreachable, REGISTRY_URL)).resolves.toEqual(
      failed("getaddrinfo ENOTFOUND registry.npmjs.org"),
    );
  });

  test("a non-2xx response is `failed` naming the status", async () => {
    await expect(
      fetchLatestVersion(PKG, registry("Unauthorized", 401), REGISTRY_URL),
    ).resolves.toEqual(failed(`registry responded 401 for ${DIST_TAGS_URL}`));
  });

  test("a body without `latest` is `absent`", async () => {
    await expect(
      fetchLatestVersion(PKG, registry({ next: "2.0.0" }), REGISTRY_URL),
    ).resolves.toEqual(ABSENT);
  });

  test("a `latest` that is not a release version is `failed`", async () => {
    await expect(
      fetchLatestVersion(PKG, registry({ latest: "2.0.0-rc.1" }), REGISTRY_URL),
    ).resolves.toEqual(failed(expect.stringMatching(/not a release version/)));
  });
});

describe("assessCurrency", () => {
  test("older than latest is stale", () => {
    expect(assessCurrency("1.26.0", ok([1, 34, 0]))).toEqual({
      kind: "stale",
      installed: [1, 26, 0],
      latest: [1, 34, 0],
    });
  });

  test("equal to latest is current", () => {
    expect(assessCurrency("1.26.0", ok([1, 26, 0]))).toEqual({
      kind: "current",
      installed: [1, 26, 0],
    });
  });

  test("newer than latest is ahead", () => {
    expect(assessCurrency("1.26.0", ok([1, 25, 9]))).toEqual({
      kind: "ahead",
      installed: [1, 26, 0],
      latest: [1, 25, 9],
    });
  });

  test("orders by the first differing component, not lexically", () => {
    expect(assessCurrency("1.9.0", ok([1, 10, 0])).kind).toBe("stale");
    expect(assessCurrency("2.0.0", ok([1, 99, 99])).kind).toBe("ahead");
  });

  test("a failed or absent lookup is unchecked, carrying the reason", () => {
    expect(assessCurrency("1.26.0", failed("fetch failed"))).toEqual({
      kind: "unchecked",
      installed: "1.26.0",
      reason: "fetch failed",
    });
    expect(assessCurrency("1.26.0", ABSENT)).toMatchObject({
      kind: "unchecked",
      reason: expect.stringContaining("no `latest` dist-tag"),
    });
  });

  // The stamp side gets the same grace as the registry side: a build that is
  // not a release version cannot be compared, and says so — it never throws.
  test("a non-release stamp is unchecked naming the stamp, whatever the lookup said", () => {
    expect(assessCurrency("1.42.0-beta.1", ok([1, 41, 3]))).toEqual({
      kind: "unchecked",
      installed: "1.42.0-beta.1",
      reason: expect.stringContaining(
        '"1.42.0-beta.1" is not a release version',
      ),
    });
  });
});

describe("currencyReport", () => {
  // The stale warning names both versions, the cause, and the exact
  // pinned command that gets the current release now — on stderr.
  test("stale: both versions, the cause, and the pinned fix on stderr", () => {
    const stale: Currency = {
      kind: "stale",
      installed: [1, 26, 0],
      latest: [1, 34, 0],
    };
    const report = currencyReport(PKG, stale);
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain("1.26.0");
    expect(report.text).toContain("latest release is 1.34.0");
    expect(report.text).toContain("minimumReleaseAge");
    expect(report.text).toContain(`pnpm dlx ${PKG}@1.34.0 install`);
  });

  // [LAW:no-silent-failure] Unreachable says "skipped" and never claims the
  // install is current.
  test("unchecked: says the check was skipped and why, never 'latest'", () => {
    const report = currencyReport(PKG, {
      kind: "unchecked",
      installed: "1.26.0",
      reason: "fetch failed",
    });
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain("skipped");
    expect(report.text).toContain("fetch failed");
    expect(report.text).not.toMatch(/latest/);
  });

  test("current and ahead are confirmations on stdout", () => {
    expect(
      currencyReport(PKG, { kind: "current", installed: [1, 41, 3] }),
    ).toEqual({
      stream: "stdout",
      text: "✓ cc-candybar 1.41.3 is the latest release.\n",
    });
    const ahead = currencyReport(PKG, {
      kind: "ahead",
      installed: [1, 42, 0],
      latest: [1, 41, 3],
    });
    expect(ahead.stream).toBe("stdout");
    expect(ahead.text).toContain("1.42.0 is newer");
    expect(ahead.text).toContain("1.41.3");
  });
});

// The branches that only run when something is already wrong, driven from
// the stamp and a fetch through to the report — the seam runInstall calls.
describe("install currency, composed", () => {
  test("stale registry → stderr warning with the pinned command", async () => {
    const currency = assessCurrency(
      "1.26.0",
      await fetchLatestVersion(PKG, registry({ latest: "1.34.0" }), REGISTRY_URL),
    );
    const report = currencyReport(PKG, currency);
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain(`pnpm dlx ${PKG}@1.34.0 install`);
  });

  test("unreachable registry → a report (never a rejection) saying skipped", async () => {
    const currency = assessCurrency(
      "1.26.0",
      await fetchLatestVersion(PKG, unreachable, REGISTRY_URL),
    );
    const report = currencyReport(PKG, currency);
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain("ENOTFOUND");
    expect(report.text).toContain("skipped");
    expect(report.text).not.toMatch(/latest/);
  });

  // Nothing on this path can throw: a bad stamp AND no registry still yield
  // a report, so the advisory check cannot take the install down.
  test("non-release stamp + unreachable registry → still a report", async () => {
    const currency = assessCurrency(
      "dev",
      await fetchLatestVersion(PKG, unreachable, REGISTRY_URL),
    );
    expect(currencyReport(PKG, currency).text).toContain(
      '"dev" is not a release version',
    );
  });
});
