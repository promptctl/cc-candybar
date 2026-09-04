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

// A registry that answers `dist-tags` with the given body and status.
function registry(body: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("parseReleaseVersion", () => {
  test("round-trips a release triple", () => {
    expect(parseReleaseVersion("1.34.0")).toEqual([1, 34, 0]);
    expect(formatVersion(parseReleaseVersion("12.0.7"))).toBe("12.0.7");
  });

  // [LAW:parse-dont-validate] Anything the ordering cannot cover is refused
  // at the border, loudly, not admitted with an undefined comparison.
  test.each(["1.2", "v1.2.3", "1.2.3-beta.1", "01.2.3", "dev", ""])(
    "refuses %j",
    (text) => {
      expect(() => parseReleaseVersion(text)).toThrow(/not a release version/);
    },
  );
});

describe("fetchLatestVersion", () => {
  test("asks the registry's dist-tags endpoint with a timeout", async () => {
    let seen: { url: string; signal: unknown } | undefined;
    const spy: typeof fetch = async (input, init) => {
      seen = { url: String(input), signal: init?.signal };
      return new Response(JSON.stringify({ latest: "1.41.3" }));
    };
    await expect(fetchLatestVersion(PKG, spy)).resolves.toEqual(ok([1, 41, 3]));
    expect(seen?.url).toBe(`${REGISTRY_URL}/-/package/${PKG}/dist-tags`);
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });

  // [LAW:no-silent-failure] Every way the lookup can fail to answer is a
  // `failed` carrying its reason — never a rejection that would take the
  // install down, never a value that could read as current.
  test("a refused connection is `failed` with the error text", async () => {
    const down: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(fetchLatestVersion(PKG, down)).resolves.toEqual(
      failed("fetch failed"),
    );
  });

  test("a non-2xx response is `failed` naming the status", async () => {
    await expect(
      fetchLatestVersion(PKG, registry("Unauthorized", 401)),
    ).resolves.toEqual(
      failed(
        `registry responded 401 for ${REGISTRY_URL}/-/package/${PKG}/dist-tags`,
      ),
    );
  });

  test("a body without `latest` is `absent`", async () => {
    await expect(
      fetchLatestVersion(PKG, registry({ next: "2.0.0" })),
    ).resolves.toEqual(ABSENT);
  });

  test("a `latest` that is not a release version is `failed`", async () => {
    await expect(
      fetchLatestVersion(PKG, registry({ latest: "2.0.0-rc.1" })),
    ).resolves.toEqual(failed(expect.stringMatching(/not a release version/)));
  });
});

describe("assessCurrency", () => {
  const installed = parseReleaseVersion("1.26.0");

  test("older than latest is stale", () => {
    expect(assessCurrency(installed, ok([1, 34, 0]))).toEqual({
      kind: "stale",
      installed,
      latest: [1, 34, 0],
    });
  });

  test("equal to latest is current", () => {
    expect(assessCurrency(installed, ok([1, 26, 0]))).toEqual({
      kind: "current",
      installed,
    });
  });

  test("newer than latest is ahead", () => {
    expect(assessCurrency(installed, ok([1, 25, 9]))).toEqual({
      kind: "ahead",
      installed,
      latest: [1, 25, 9],
    });
  });

  test("orders by the first differing component, not lexically", () => {
    expect(assessCurrency([1, 9, 0], ok([1, 10, 0])).kind).toBe("stale");
    expect(assessCurrency([2, 0, 0], ok([1, 99, 99])).kind).toBe("ahead");
  });

  test("a failed or absent lookup is unchecked, carrying the reason", () => {
    expect(assessCurrency(installed, failed("fetch failed"))).toEqual({
      kind: "unchecked",
      installed,
      reason: "fetch failed",
    });
    expect(assessCurrency(installed, ABSENT)).toMatchObject({
      kind: "unchecked",
      reason: expect.stringContaining("no `latest` dist-tag"),
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
      installed: [1, 26, 0],
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

// The two branches that only run when something is already wrong, driven end
// to end: a registry answer that is ahead of the stamp, and no registry at all.
describe("install currency, composed", () => {
  test("stale registry → stderr warning with the pinned command", async () => {
    const currency = assessCurrency(
      parseReleaseVersion("1.26.0"),
      await fetchLatestVersion(PKG, registry({ latest: "1.34.0" })),
    );
    const report = currencyReport(PKG, currency);
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain(`pnpm dlx ${PKG}@1.34.0 install`);
  });

  test("unreachable registry → resolves (exit 0 path) and reports skipped", async () => {
    const down: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    };
    const currency = assessCurrency(
      parseReleaseVersion("1.26.0"),
      await fetchLatestVersion(PKG, down),
    );
    const report = currencyReport(PKG, currency);
    expect(report.stream).toBe("stderr");
    expect(report.text).toContain("ENOTFOUND");
    expect(report.text).toContain("skipped");
    expect(report.text).not.toMatch(/latest/);
  });
});
