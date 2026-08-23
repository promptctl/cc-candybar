// The remote → browsable-page contract. `remoteWebUrl` is a parse boundary:
// a string it returns has already been through the URL parser, carries an
// http(s) scheme, has had any credentials stripped, and names a repo path — so
// the render boundary links it without re-checking. These tests are that
// promise, stated as the accept/reject table.
// [LAW:behavior-not-structure] Every case asserts the URL a browser would be
// handed, never how the transposition is spelled internally.

import {
  detectForge,
  forgeRemoteUrl,
  parseRemoteRef,
  parseRemotes,
  remoteWebUrl,
  repoNameFromUrl,
  repoRemoteUrl,
  repoWebUrl,
  type GitRemote,
} from "../src/segments/git";

describe("remoteWebUrl — http(s) remotes are already the page", () => {
  test.each([
    ["https://github.com/promptctl/cc-candybar.git", "https://github.com/promptctl/cc-candybar"],
    ["https://github.com/promptctl/cc-candybar", "https://github.com/promptctl/cc-candybar"],
    // A trailing slash is chrome, not path.
    ["https://gitlab.com/group/proj/", "https://gitlab.com/group/proj"],
    // Nested groups (GitLab) and tildes (sr.ht) are ordinary path, untouched.
    ["https://gitlab.com/group/sub/proj.git", "https://gitlab.com/group/sub/proj"],
    ["https://git.sr.ht/~user/repo", "https://git.sr.ht/~user/repo"],
    // A self-hosted forge's web port IS part of its address — keep it.
    ["http://gitea.lan:3000/me/notes.git", "http://gitea.lan:3000/me/notes"],
    ["https://codeberg.org/me/notes.git", "https://codeberg.org/me/notes"],
    // Host case is not meaningful; the parser normalizes it.
    ["https://GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });
});

describe("remoteWebUrl — nothing raw reaches the OSC-8 sink", () => {
  // A git remote is attacker-influenced in any repo you clone, and `git.repoUrl`
  // feeds `{{ link }}`, which emits an OSC-8 hyperlink. That sequence is
  // delimited by BEL (0x07) and ST (ESC \), so a raw control character in a repo
  // path could terminate it early and inject terminal escapes.
  //
  // It cannot: the reassembly reads `parseRemoteRef`'s path, which the URL
  // parser has already run through the path percent-encode set (C0 controls and
  // space included, for non-special schemes like `ssh:` too). This asserts that
  // property rather than trusting it — a future change to the reassembly that
  // starts emitting raw bytes has to fail here.
  test.each([
    ["git@example.com:My Repo.git", "https://example.com/My%20Repo"],
    ["ssh://git@example.com/My Repo.git", "https://example.com/My%20Repo"],
    [
      "git@example.com:a\x1b]8;;evil\x07b.git",
      "https://example.com/a%1B]8;;evil%07b",
    ],
  ])("%j → %s", (remote, expected) => {
    const web = remoteWebUrl(remote);
    expect(web).toBe(expected);
    expect(web).not.toMatch(/[\x00-\x1f\x7f ]/);
  });

  test("a remote the URL parser cannot represent yields nothing at all", () => {
    expect(remoteWebUrl("git@example.com:a\nb.git")).toBeNull();
  });
});

describe("remoteWebUrl — credentials never reach a clickable link", () => {
  // [LAW:no-silent-failure] A CI-style remote carries a token. Rendering it
  // into an OSC-8 link would publish the secret into the terminal and into
  // whatever the click opens. The host forms exclude userinfo by construction,
  // and these cases are the proof of that, not a reminder to be careful.
  test.each([
    ["https://user@github.com/o/r.git", "https://github.com/o/r"],
    ["https://x-access-token:ghp_SECRET@github.com/o/r.git", "https://github.com/o/r"],
    ["ssh://git@github.com/o/r.git", "https://github.com/o/r"],
  ])("%s → %s", (remote, expected) => {
    const web = remoteWebUrl(remote);
    expect(web).toBe(expected);
    expect(web).not.toMatch(/@|SECRET/);
  });
});

describe("remoteWebUrl — ssh transposes to the same host and path", () => {
  test.each([
    // scp shorthand, the form every forge prints in its clone box.
    ["git@github.com:promptctl/cc-candybar.git", "https://github.com/promptctl/cc-candybar"],
    ["git@gitlab.com:group/sub/proj.git", "https://gitlab.com/group/sub/proj"],
    ["git@bitbucket.org:team/repo.git", "https://bitbucket.org/team/repo"],
    // Self-hosted Gitea/Forgejo — the case a hostname allow-list could never
    // recognize, and the reason the discriminator is URL SHAPE, not host name.
    ["git@code.homelab:brandon/notes.git", "https://code.homelab/brandon/notes"],
    ["forgejo@git.example.org:team/thing.git", "https://git.example.org/team/thing"],
    // Explicit ssh:// form, with and without a port. An ssh port says nothing
    // about the web port, so it is DROPPED rather than carried over.
    ["ssh://git@gitea.lan:2222/me/notes.git", "https://gitea.lan/me/notes"],
    ["ssh://git@gitlab.example.com:22/group/proj.git", "https://gitlab.example.com/group/proj"],
    // The (unauthenticated, deprecated) git:// protocol transposes the same way.
    ["git://github.com/o/r.git", "https://github.com/o/r"],
    // An absolute scp path is still a path on that host.
    ["git@git.example.org:/team/thing.git", "https://git.example.org/team/thing"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });
});

describe("remoteWebUrl — remotes with no page yield nothing", () => {
  // [LAW:parse-dont-validate] null is the typed absence, and it is the ONLY
  // rejection channel: nothing here degrades into a plausible-looking URL.
  test.each([
    ["", "empty remote"],
    ["   ", "blank remote"],
    ["/srv/git/notes.git", "absolute local path"],
    ["../sibling-repo", "relative local path"],
    ["./repo", "dot-relative local path"],
    ["file:///srv/git/notes", "file:// mirror — nothing serves it"],
    ["git@github.com:", "host but no repo path"],
    ["https://github.com", "host but no repo path"],
    ["https://github.com/", "host but no repo path"],
    ["ftp://example.com/repo.git", "scheme that serves no repo page"],
  ])("%s (%s) → null", (remote) => {
    expect(remoteWebUrl(remote)).toBeNull();
  });
});

describe("remoteWebUrl — a drive path is a local path, not host:path", () => {
  // A DOS drive prefix once slipped through the scp arm and made the drive
  // letter a hostname: `C:/repo.git` linked to a host named `c`.
  test.each([
    ["C:/repo.git", "forward-slash drive path"],
    ["C:\\repo.git", "backslash drive path"],
    ["d:/work/notes", "lowercase drive letter"],
  ])("%s (%s) → null", (remote) => {
    expect(remoteWebUrl(remote)).toBeNull();
  });

  // The rejection requires the separator on purpose. A single-letter host is a
  // real ssh-config alias, and `^[A-Za-z]:` alone would have taken it out.
  test("a single-letter ssh alias is still a host", () => {
    expect(remoteWebUrl("h:repo.git")).toBe("https://h/repo");
    expect(remoteWebUrl("git@h:team/repo.git")).toBe("https://h/team/repo");
  });
});

describe("remoteWebUrl — host case does not change the answer", () => {
  // The ssh arm used to emit a mixed-case host while `detectForge` lowercased:
  // WHATWG normalizes host case for "special" schemes only, so `https:` was
  // folded and `ssh:` was not. One parser, one normalization, both readers.
  test.each([
    ["git@GitHub.com:Me/Repo.git", "https://github.com/Me/Repo"],
    ["ssh://git@GitLab.COM/g/p.git", "https://gitlab.com/g/p"],
    ["https://GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });

  // Path case is user data and survives untouched — only the host is normalized.
  test("the repo path keeps its case", () => {
    expect(remoteWebUrl("git@github.com:Me/MyRepo.git")).toContain("/Me/MyRepo");
  });
});

describe("remoteWebUrl — one host classification, shared with detectForge", () => {
  // [LAW:single-enforcer] The two questions asked of a remote must classify the
  // same string the same way. A forge this recognizes must also yield a page on
  // that same host; a shape one rejects the other cannot silently accept.
  test.each([
    "git@GitHub.com:o/r.git",
    "https://gitlab.example.com/g/p.git",
    "ssh://git@github.com:22/o/r.git",
  ])("%s: detected forge host is the page host", (remote) => {
    const forge = detectForge(remote);
    const web = remoteWebUrl(remote);
    expect(forge).not.toBeNull();
    expect(web).not.toBeNull();
    expect(new URL(web!).hostname).toBe(parseRemoteRef(remote)!.host);
  });

  test.each(["C:/repo.git", "/srv/git/r.git", "../r"])(
    "%s: rejected by both",
    (remote) => {
      expect(parseRemoteRef(remote)).toBeNull();
      expect(detectForge(remote)).toBeNull();
      expect(remoteWebUrl(remote)).toBeNull();
    },
  );
});

describe("parseRemoteRef — git's two spellings decode to one shape", () => {
  test("scp shorthand and its ssh:// equivalent agree", () => {
    expect(parseRemoteRef("git@github.com:o/r.git")).toEqual(
      parseRemoteRef("ssh://git@github.com/o/r.git"),
    );
  });

  test("a single-slash scheme is an ssh host, matching git itself", () => {
    // `git ls-remote "file:/tmp/x"` → "Could not resolve hostname file". Per
    // `git help clone` the scp form is recognized when no slash precedes the
    // first colon, which this satisfies. Disagreeing with git about what a
    // repo's own remote means would be the worse answer.
    expect(parseRemoteRef("file:/srv/git/notes.git")).toMatchObject({
      scheme: "ssh",
      host: "file",
      path: "srv/git/notes.git",
    });
  });

  test("a true file:// URL has no host", () => {
    expect(parseRemoteRef("file:///srv/git/notes")).toMatchObject({
      scheme: "file",
      host: "",
    });
  });

  test("port and credentials are separated out, never carried in the host", () => {
    expect(parseRemoteRef("ssh://git@gitea.lan:2222/me/notes.git")).toEqual({
      scheme: "ssh",
      host: "gitea.lan",
      port: "2222",
      path: "me/notes.git",
    });
    expect(parseRemoteRef("https://x-token:secret@github.com/o/r.git")).toEqual({
      scheme: "https",
      host: "github.com",
      port: "",
      path: "o/r.git",
    });
  });
});

describe("parseRemotes", () => {
  test("one line per remote URL, name and URL split apart", () => {
    const stdout = [
      "remote.origin.url git@github.com:promptctl/cc-candybar.git",
      "remote.upstream.url https://github.com/upstream/cc-candybar.git",
    ].join("\n");
    expect(parseRemotes(stdout)).toEqual([
      {
        name: "origin",
        urls: ["git@github.com:promptctl/cc-candybar.git"],
      },
      {
        name: "upstream",
        urls: ["https://github.com/upstream/cc-candybar.git"],
      },
    ]);
  });

  test("a dotted remote name keeps its dots", () => {
    expect(parseRemotes("remote.my.fork.url git@github.com:me/r.git")).toEqual([
      { name: "my.fork", urls: ["git@github.com:me/r.git"] },
    ]);
  });

  test("every URL of a multi-URL remote is kept, in config order", () => {
    // Dropping the later URLs lost the only one naming a forge when a repo
    // fetches from a mirror and pushes to GitHub — costing both the link and
    // the PR lookup. Which URL identifies the repo is decided downstream.
    const stdout = [
      "remote.origin.url /srv/mirror/r.git",
      "remote.origin.url git@github.com:me/r.git",
    ].join("\n");
    expect(parseRemotes(stdout)).toEqual([
      {
        name: "origin",
        urls: ["/srv/mirror/r.git", "git@github.com:me/r.git"],
      },
    ]);
  });

  test("no remotes configured is an empty list", () => {
    expect(parseRemotes("")).toEqual([]);
  });

  test("a remote configured with no URL is not a remote with a URL", () => {
    expect(
      parseRemotes("remote.broken.url \nremote.origin.url git@h:o/r.git"),
    ).toEqual([{ name: "origin", urls: ["git@h:o/r.git"] }]);
  });
});

describe("the repo's identity — one selection, shared by name and link", () => {
  const remotes = (...rs: GitRemote[]): GitRemote[] => rs;
  const one = (name: string, url: string): GitRemote => ({
    name,
    urls: [url],
  });

  test("origin wins over every other remote", () => {
    expect(
      repoWebUrl(
        remotes(
          one("upstream", "git@github.com:upstream/r.git"),
          one("origin", "git@github.com:me/r.git"),
        ),
      ),
    ).toBe("https://github.com/me/r");
  });

  test("without an origin, the first remote wins", () => {
    expect(
      repoWebUrl(
        remotes(
          one("gh", "git@github.com:me/r.git"),
          one("backup", "/srv/mirrors/r.git"),
        ),
      ),
    ).toBe("https://github.com/me/r");
  });

  // [LAW:one-source-of-truth] The selection ignores browsability, so the NAME
  // and the LINK always describe the same repository. Falling through to
  // another remote's page rendered `backup` beside a link to `realname`.
  test("an unbrowsable origin means no link, not another repo's page", () => {
    const rs = remotes(
      one("origin", "/srv/mirrors/backup.git"),
      one("gh", "git@github.com:me/realname.git"),
    );
    expect(repoWebUrl(rs)).toBeNull();
    expect(repoRemoteUrl(rs)).toBe("/srv/mirrors/backup.git");
  });

  // Within the picked remote, the URL that can identify a repo wins — so a
  // fetch-from-mirror / push-to-forge remote keeps its forge identity, and
  // detectForge (which gates the whole PR lookup) sees a URL it recognizes.
  test("a remote's forge URL wins over its local mirror URL", () => {
    const rs = remotes({
      name: "origin",
      urls: ["/srv/mirror/r.git", "git@github.com:me/r.git"],
    });
    expect(repoRemoteUrl(rs)).toBe("git@github.com:me/r.git");
    expect(repoWebUrl(rs)).toBe("https://github.com/me/r");
    expect(detectForge(repoRemoteUrl(rs)!)).toBe("github");
  });

  test("a repo whose remotes are all unbrowsable has no page", () => {
    expect(repoWebUrl(remotes(one("origin", "/srv/mirrors/r.git")))).toBeNull();
  });

  test("a repo with no remotes has no page", () => {
    expect(repoWebUrl([])).toBeNull();
    expect(repoRemoteUrl([])).toBeNull();
  });
});

describe("the repo's name and its link never disagree", () => {
  // [LAW:one-source-of-truth] Both project the PARSED path. A raw-string regex
  // disagreed with the link for a slashless scp remote and for a trailing
  // slash, silently falling through to the directory basename while the link
  // resolved fine. Each case asserts name and link TOGETHER — asserting either
  // alone is exactly what let that survive.
  const nameOf = repoNameFromUrl;

  test.each([
    ["git@host:repo.git", "repo", "https://host/repo"],
    ["h:repo.git", "repo", "https://h/repo"],
    ["https://github.com/me/repo/", "repo", "https://github.com/me/repo"],
    ["https://github.com/me/repo.git", "repo", "https://github.com/me/repo"],
    ["git@github.com:me/sub/repo.git", "repo", "https://github.com/me/sub/repo"],
  ])("%s → name %s, link %s", (url, name, link) => {
    expect(nameOf(url)).toBe(name);
    expect(remoteWebUrl(url)).toBe(link);
  });

  // A local-path remote has no parsed path but does have a last segment, so it
  // keeps naming itself. The directory basename stays reserved for its
  // documented case: a repo with no remote at all.
  test.each(["/srv/mirrors/backup.git", "/srv/mirrors/backup.git/"])(
    "a local-path remote (%s) names itself, with no link",
    (url) => {
      expect(nameOf(url)).toBe("backup");
      expect(remoteWebUrl(url)).toBeNull();
    },
  );

  // The no-remote case is the directory-basename policy, asserted against real
  // git in test/git-service-outcomes.test.ts where the working dir is real.
});

describe("forgeRemoteUrl — identity and forge dispatch are different questions", () => {
  // detectForge gates the whole PR lookup before gh/glab spawns, so a
  // browsable-but-unrecognized mirror listed first must not shadow a recognized
  // forge behind it. Identity still points at the first browsable url.
  test("a recognized forge is not shadowed by a browsable non-forge url", () => {
    const remotes = [
      {
        name: "origin",
        urls: ["git@gitea.example.com:o/r.git", "git@github.com:o/r.git"],
      },
    ];
    expect(repoWebUrl(remotes)).toBe("https://gitea.example.com/o/r");
    expect(forgeRemoteUrl(remotes)).toBe("git@github.com:o/r.git");
    expect(detectForge(forgeRemoteUrl(remotes)!)).toBe("github");
  });

  test("with no recognized forge, dispatch falls back to identity", () => {
    const remotes = [{ name: "origin", urls: ["git@gitea.example.com:o/r.git"] }];
    expect(forgeRemoteUrl(remotes)).toBe(repoRemoteUrl(remotes));
  });

  test("the two agree in a single-url config", () => {
    const remotes = [{ name: "origin", urls: ["git@github.com:o/r.git"] }];
    expect(forgeRemoteUrl(remotes)).toBe(repoRemoteUrl(remotes));
  });
});

describe("remoteWebUrl — IPv6 literals, in both of git's spellings", () => {
  // git accepts `git@[2001:db8::1]:repo.git` (confirmed via `git remote -v`).
  // The generic scp arm stopped at the first colon inside the brackets and
  // took `[2001` as the host, so the URL parse threw and the link vanished.
  test("the bracketed scp form and its ssh:// equivalent agree", () => {
    expect(parseRemoteRef("git@[2001:db8::1]:repo.git")).toEqual(
      parseRemoteRef("ssh://git@[2001:db8::1]/repo.git"),
    );
  });

  test.each([
    ["git@[2001:db8::1]:repo.git", "https://[2001:db8::1]/repo"],
    ["ssh://git@[2001:db8::1]/repo.git", "https://[2001:db8::1]/repo"],
    ["[2001:db8::1]:repo.git", "https://[2001:db8::1]/repo"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });
});
