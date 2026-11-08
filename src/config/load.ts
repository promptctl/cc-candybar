// [LAW:decomposition] A session's config chain, read from its disk and parsed.
// Everything a load asks the disk goes through the `reads` it is handed: the
// answers book, each candidate's presence, each repository's worktree link,
// the plugin folders, every layer and every definition. Building a render
// state from the result is the render cache's (src/daemon/cache/render.ts).
//
// [LAW:effects-at-boundaries] Over the filesystem fake, a load is a value a
// test builds with no daemon.

import type { FilesystemReads } from "../disk/filesystem.js";
import type { Locations } from "../daemon/paths.js";
import { DEFAULT_DSL_CONFIG } from "./default-dsl-config.js";
import {
  ConfigError,
  loadConfigChain,
  type InstalledLayerMemo,
  type LoadedChain,
} from "./dsl-loader.js";
import {
  configResolutionNotice,
  detectConfigCollisions,
  resolveDslConfig,
  type ConfigLayer,
} from "./loader/discovery.js";
import { readRepoAnswers } from "./loader/repo-book.js";
import {
  repoUnreadNotice,
  type ApprovedRepo,
  type RepoGate,
} from "./loader/repo-gate.js";

// The files a config is merged from, lowest first, and the one durable
// clicks write — `resolveDslConfig`'s chain, or the bundled default's empty
// one.
export interface ConfigChain {
  readonly layers: readonly ConfigLayer[];
  readonly home: string;
  // The session's project, once approved: where the plugins it ships live.
  readonly repo: ApprovedRepo | null;
  // Where the installed plugins the chain loads over live.
  readonly locs: Locations;
}

// [LAW:types-are-the-program] A chain parsed, or the throw that refused it,
// each with the advisories the chain earned before it settled: a refusal
// carries the ones its layers earned before they failed.
export type ParsedChain =
  | {
      readonly kind: "parsed";
      readonly loaded: LoadedChain;
      readonly warnings: readonly string[];
    }
  | {
      readonly kind: "failed";
      readonly cause: unknown;
      readonly warnings: readonly string[];
    };

// What one session's load is asked for: where its chain is searched, whose
// answers gate its repositories, and the memo its caller holds.
export interface LoadRequest {
  readonly locations: Locations;
  readonly stateDir: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly configFile: string | undefined;
  readonly memo: InstalledLayerMemo;
}

// A session's config, as its disk said it is.
export interface ConfigLoad {
  readonly cwd: string;
  readonly chain: ConfigChain;
  readonly repos: RepoGate;
  // The resolution's advisories, which run whether or not the chain parses:
  // a shadowed `.json` sibling, an explicit path that is not there, a book
  // that could not be read. The cache watches every candidate path, so a
  // sibling or the named file appearing reloads and is judged again; nothing
  // else invalidates these.
  readonly advisories: ReadonlyArray<string | null>;
  readonly parsed: ParsedChain;
}

// [LAW:single-enforcer] Each layer validated over the layers it joins, so
// cross-ref diagnostics name the failing file's own paths and lines, and every
// advisory a layer earns appended before its validation, so a cross-ref
// failure still carries them (a duplicate key names its line beside the
// error).
export function parseChain(
  reads: FilesystemReads,
  memo: InstalledLayerMemo,
  cwd: string,
  chain: ConfigChain,
): ParsedChain {
  const warnings: string[] = [];
  try {
    const loaded = loadConfigChain(
      reads,
      memo,
      chain.locs,
      chain.layers,
      DEFAULT_DSL_CONFIG,
      { warned: (w) => warnings.push(...w) },
      { repo: chain.repo, cwd },
    );
    return { kind: "parsed", loaded, warnings };
  } catch (cause) {
    if (cause instanceof ConfigError) warnings.push(...cause.warnings);
    return { kind: "failed", cause, warnings };
  }
}

// [LAW:dataflow-not-control-flow] The search, its advisories and the parse,
// every time: `missing` and `unreadable` parse the bundled default's empty
// chain, and what tells them apart is an advisory, not a load path.
export function readConfigLoad(
  reads: FilesystemReads,
  request: LoadRequest,
): ConfigLoad {
  const { locations, projectDir, cwd, configFile } = request;
  const resolution = resolveDslConfig(
    reads,
    locations,
    readRepoAnswers(reads, request.stateDir),
    projectDir,
    cwd,
    configFile,
  );
  const { repos } = resolution;
  const chain: ConfigChain = {
    layers: resolution.kind === "chain" ? resolution.layers : [],
    home: resolution.home,
    repo: repos.plugins,
    locs: locations,
  };
  return {
    cwd,
    chain,
    repos,
    advisories: [
      detectConfigCollisions(reads, locations, projectDir, cwd),
      configResolutionNotice(resolution),
      repoUnreadNotice(repos),
    ],
    parsed: parseChain(reads, request.memo, cwd, chain),
  };
}
