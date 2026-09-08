// [LAW:behavior-not-structure] `remoteWebUrl` is a parse boundary: what it returns has an http(s) scheme, no credentials, and a repo path.

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
    ["https://gitlab.com/group/proj/", "https://gitlab.com/group/proj"],
    ["https://gitlab.com/group/sub/proj.git", "https://gitlab.com/group/sub/proj"],
    ["https://git.sr.ht/~user/repo", "https://git.sr.ht/~user/repo"],
    ["http://gitea.lan:3000/me/notes.git", "http://gitea.lan:3000/me/notes"],
    ["https://codeberg.org/me/notes.git", "https://codeberg.org/me/notes"],
    ["https://GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });
});

describe("remoteWebUrl — nothing raw reaches the OSC-8 sink", () => {
  // A remote is attacker-influenced and feeds an OSC-8 link, so a raw control byte could terminate the sequence early.
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
  // [LAW:no-silent-failure] The host forms exclude userinfo by construction; these are the proof.
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
    ["git@github.com:promptctl/cc-candybar.git", "https://github.com/promptctl/cc-candybar"],
    ["git@gitlab.com:group/sub/proj.git", "https://gitlab.com/group/sub/proj"],
    ["git@bitbucket.org:team/repo.git", "https://bitbucket.org/team/repo"],
    // The case a hostname allow-list could never recognize: the discriminator is URL SHAPE.
    ["git@code.homelab:brandon/notes.git", "https://code.homelab/brandon/notes"],
    ["forgejo@git.example.org:team/thing.git", "https://git.example.org/team/thing"],
    // An ssh port says nothing about the web port, so it is DROPPED.
    ["ssh://git@gitea.lan:2222/me/notes.git", "https://gitea.lan/me/notes"],
    ["ssh://git@gitlab.example.com:22/group/proj.git", "https://gitlab.example.com/group/proj"],
    ["git://github.com/o/r.git", "https://github.com/o/r"],
    ["git@git.example.org:/team/thing.git", "https://git.example.org/team/thing"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });
});

describe("remoteWebUrl — remotes with no page yield nothing", () => {
  // [LAW:parse-dont-validate] null is the typed absence and the ONLY rejection channel.
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
  test.each([
    ["C:/repo.git", "forward-slash drive path"],
    ["C:\\repo.git", "backslash drive path"],
    ["d:/work/notes", "lowercase drive letter"],
  ])("%s (%s) → null", (remote) => {
    expect(remoteWebUrl(remote)).toBeNull();
  });

  // A single-letter host is a real ssh-config alias, so the separator is required.
  test("a single-letter ssh alias is still a host", () => {
    expect(remoteWebUrl("h:repo.git")).toBe("https://h/repo");
    expect(remoteWebUrl("git@h:team/repo.git")).toBe("https://h/team/repo");
  });
});

describe("remoteWebUrl — host case does not change the answer", () => {
  // WHATWG normalizes host case for "special" schemes only, so ssh must be folded too.
  test.each([
    ["git@GitHub.com:Me/Repo.git", "https://github.com/Me/Repo"],
    ["ssh://git@GitLab.COM/g/p.git", "https://gitlab.com/g/p"],
    ["https://GitHub.com/Me/Repo.git", "https://github.com/Me/Repo"],
  ])("%s → %s", (remote, expected) => {
    expect(remoteWebUrl(remote)).toBe(expected);
  });

  test("the repo path keeps its case", () => {
    expect(remoteWebUrl("git@github.com:Me/MyRepo.git")).toContain("/Me/MyRepo");
  });
});

describe("remoteWebUrl — one host classification, shared with detectForge", () => {
  // [LAW:single-enforcer] Both questions must classify the same string the same way.
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
    // git itself reads a slashless single-colon form as scp; disagreeing would be worse.
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

  // [LAW:one-source-of-truth] The selection ignores browsability, so name and link agree.
  test("an unbrowsable origin means no link, not another repo's page", () => {
    const rs = remotes(
      one("origin", "/srv/mirrors/backup.git"),
      one("gh", "git@github.com:me/realname.git"),
    );
    expect(repoWebUrl(rs)).toBeNull();
    expect(repoRemoteUrl(rs)).toBe("/srv/mirrors/backup.git");
  });

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
  // [LAW:one-source-of-truth] Both project the PARSED path; asserting either alone hid a bug.
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

  test.each(["/srv/mirrors/backup.git", "/srv/mirrors/backup.git/"])(
    "a local-path remote (%s) names itself, with no link",
    (url) => {
      expect(nameOf(url)).toBe("backup");
      expect(remoteWebUrl(url)).toBeNull();
    },
  );
});

describe("forgeRemoteUrl — identity and forge dispatch are different questions", () => {
  // detectForge gates the PR lookup before gh/glab spawns; identity takes the first browsable url.
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
  // git accepts the bracketed scp form; the first colon inside the brackets is not the separator.
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
