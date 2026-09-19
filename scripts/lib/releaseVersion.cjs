'use strict';

/**
 * @file scripts/lib/releaseVersion.cjs
 *
 * The extension's release version is a.b.c.d. Only `a` is written down (the
 * major of package.json's version); the rest is counted from git history at
 * build time, so the version moves with every commit without anyone bumping it:
 *
 *   a  package.json's major — changed by hand, for a deliberate new era
 *   b  pull requests merged since `a` was last raised
 *   c  Feature commits since the last merged pull request
 *   d  Fix / Refactor / Perf / Draft / Revert commits since the last Feature
 *
 * A higher segment going up resets the ones after it, the way 1.2.9 is followed
 * by 1.3.0: a branch's own features and fixes show while it is being built and
 * tested (0.15.6.2) and are folded into its merge once it lands (0.16.0.0). So a
 * commit's version is never lower than its parent's, which is what Chrome's
 * update check needs.
 *
 * c and d are counted along the first-parent chain, so a merged branch's commits
 * are never counted twice. b counts every pull-request merge in the history, so
 * a branch that merged main in still knows how many pull requests it contains.
 * Pull requests must be merged with a merge commit: a squash or rebase merge
 * leaves nothing to count.
 */

const { execFileSync } = require('node:child_process');
const { toChromeManifestVersion } = require('./manifestVersion.cjs');

/** Commit subject prefixes, the segment each bumps, and accepted aliases. */
const PREFIXES = [
  { name: 'Feature', bump: 'c', aliases: ['feat'] },
  { name: 'Fix', bump: 'd' },
  { name: 'Refactor', bump: 'd' },
  { name: 'Perf', bump: 'd' },
  { name: 'Draft', bump: 'd' },
  { name: 'Testing', bump: 'none', aliases: ['test'] },
  { name: 'Docs', bump: 'none' },
  { name: 'Infrastructure', bump: 'none' },
  { name: 'Setup', bump: 'none' },
  { name: 'Release', bump: 'none' },
];

const BUMP_BY_PREFIX = new Map(
  PREFIXES.flatMap(({ name, bump, aliases = [] }) =>
    [name, ...aliases].map((prefix) => [prefix.toLowerCase(), bump]))
);

// `Feature:`, `feat(popup):`, `fix!:` — case does not matter.
const SUBJECT_PREFIX = /^([A-Za-z]+)(?:\([^)]*\))?!?:/;
const AUTOSQUASH = /^(?:fixup|squash|amend)! /;
// Merging main into a branch (or pulling it) is not a pull request.
const SYNC_MERGE = /^Merge (?:remote-tracking )?branch '(?:origin\/)?(?:main|master)'/;

/**
 * Which segment a commit bumps: 'c', 'd' or 'none'; null when the prefix is not
 * one of ours (old history has a few, and they bump nothing).
 * @param {string} subject
 * @returns {'c' | 'd' | 'none' | null}
 */
function commitBump(subject) {
  const text = String(subject).trim().replace(AUTOSQUASH, '');
  if (text.startsWith('Revert "')) return 'd';
  const match = SUBJECT_PREFIX.exec(text);
  if (!match) return null;
  return BUMP_BY_PREFIX.get(match[1].toLowerCase()) ?? null;
}

/** @param {string} subject of a merge commit */
function isPullRequestMerge(subject) {
  return !SYNC_MERGE.test(subject);
}

/**
 * @param {object} history everything since the commit that set the current major
 * @param {number} history.major a
 * @param {string[]} history.mergeSubjects every merge commit in the history
 * @param {{ subject: string, merge: boolean }[]} history.firstParent the
 *   first-parent chain, newest first
 * @returns {string} a.b.c.d
 */
function deriveReleaseVersion({ major, mergeSubjects, firstParent }) {
  const pullRequests = mergeSubjects.filter(isPullRequestMerge).length;
  let features = 0;
  let fixes = 0;
  for (const commit of firstParent) {
    if (commit.merge) {
      if (isPullRequestMerge(commit.subject)) break;
      continue;
    }
    const bump = commitBump(commit.subject);
    if (bump === 'c') features += 1;
    // Only fixes newer than the newest feature: a feature resets d.
    else if (bump === 'd' && features === 0) fixes += 1;
  }
  return toChromeManifestVersion(`${major}.${pullRequests}.${features}.${fixes}`);
}

/** @param {unknown} version a package.json version such as "1.0.0" */
function majorOf(version) {
  const match = /^(\d+)\./.exec(String(version));
  return match ? Number(match[1]) : NaN;
}

/** Runs git; with `input`, it is fed to stdin and the raw output comes back as a Buffer. */
function git(cwd, args, input) {
  return execFileSync('git', args, {
    cwd,
    input: input === undefined ? undefined : Buffer.from(input),
    encoding: input === undefined ? 'utf8' : undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lines(output) {
  return output.split('\n').filter(Boolean);
}

/** The major in package.json at each revision, NaN where it cannot be read. */
function readPackageMajors(cwd, revisions) {
  const out = git(cwd, ['cat-file', '--batch'], revisions.map((rev) => `${rev}:package.json\n`).join(''));
  const majors = [];
  let offset = 0;
  for (let i = 0; i < revisions.length; i += 1) {
    const headerEnd = out.indexOf(0x0a, offset);
    const size = / blob (\d+)$/.exec(out.toString('utf8', offset, headerEnd));
    offset = headerEnd + 1;
    if (!size) {
      majors.push(NaN);
      continue;
    }
    const length = Number(size[1]);
    try {
      majors.push(majorOf(JSON.parse(out.toString('utf8', offset, offset + length)).version));
    } catch {
      majors.push(NaN);
    }
    offset += length + 1;
  }
  return majors;
}

/**
 * The first-parent commit that raised the major to its current value, so b, c
 * and d start over from it. 'uncommitted' when the major was changed but not
 * committed yet; null when it was never raised to this value, so counting starts
 * at the first commit. A lowered major is not a new era: this history went from
 * 1.0.0 down to 0.8.9 before release, and restarting b there would put today's
 * version below the 0.9.x versions already built.
 */
function findMajorAnchor(cwd, rev, major) {
  const touching = lines(git(cwd, ['log', '--first-parent', '--format=%H', rev, '--', 'package.json']));
  const [atRev, ...majors] = readPackageMajors(cwd, [rev, ...touching]);
  if (atRev !== major) return 'uncommitted';
  const lower = majors.findIndex((value) => !(value >= major));
  if (lower === -1) return null;
  return lower === 0 ? rev : touching[lower - 1];
}

/**
 * Counts the release version of a commit from git history.
 * @param {object} options
 * @param {string} options.cwd a directory inside the repository
 * @param {string} [options.rev] the commit to version, HEAD by default
 * @param {string} [options.packageVersion] the working tree's package.json
 *   version, which may carry an uncommitted new major; read from `rev` if omitted
 * @returns {string} a.b.c.d
 */
function readReleaseVersion({ cwd, rev = 'HEAD', packageVersion }) {
  if (git(cwd, ['rev-parse', '--is-shallow-repository']).trim() === 'true') {
    throw new Error('this is a shallow clone, so the history cannot be counted — run `git fetch --unshallow`');
  }
  const major = packageVersion === undefined ? readPackageMajors(cwd, [rev])[0] : majorOf(packageVersion);
  if (!Number.isInteger(major)) {
    throw new Error(`package.json at ${rev} has no numeric major version`);
  }
  const anchor = findMajorAnchor(cwd, rev, major);
  if (anchor === 'uncommitted') return toChromeManifestVersion(`${major}.0.0.0`);
  const range = anchor ? [`^${anchor}`, rev] : [rev];
  const mergeSubjects = lines(git(cwd, ['log', '--merges', '--format=%s', ...range]));
  const firstParent = lines(git(cwd, ['log', '--first-parent', '--format=%P%x09%s', ...range])).map((line) => {
    const tab = line.indexOf('\t');
    return { merge: line.slice(0, tab).includes(' '), subject: line.slice(tab + 1) };
  });
  return deriveReleaseVersion({ major, mergeSubjects, firstParent });
}

/** Whether tracked files differ from HEAD, so a build is not exactly that commit. */
function hasUncommittedChanges(cwd) {
  return git(cwd, ['status', '--porcelain', '--untracked-files=no']).trim() !== '';
}

/**
 * The manifest's display version: the plain number for a clean release build,
 * with what makes this build differ from that commit in brackets otherwise.
 */
function releaseVersionName(version, { dev = false, dirty = false, fromGit = true } = {}) {
  const notes = [dev && 'dev', dirty && 'uncommitted changes', !fromGit && 'no git history'].filter(Boolean);
  return notes.length ? `${version} (${notes.join(', ')})` : version;
}

function describePrefixes() {
  const group = (bump) => PREFIXES.filter((prefix) => prefix.bump === bump).map(({ name }) => `${name}:`).join(' ');
  return [
    `  ${group('c')}  bumps c — something new the extension does`,
    `  ${group('d')}  bumps d — changed code, no new feature (a revert counts too)`,
    `  ${group('none')}  no bump — nothing shipped changes`,
    'Lowercase and scoped forms (feat(popup):, fix:) count the same.',
  ].join('\n');
}

/**
 * Why a commit message would be rejected, or null when it is fine. The prefix
 * decides the release version, so an unknown one would count as nothing.
 * @param {string} message the full commit message
 * @returns {string | null}
 */
function commitMessageProblem(message) {
  const subject = String(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#'));
  // An empty message is refused by git itself.
  if (!subject || subject.startsWith('Merge') || commitBump(subject) !== null) return null;
  return [
    `Commit subject "${subject}" does not start with a known prefix.`,
    'The prefix decides the release version (a.b.c.d):',
    describePrefixes(),
  ].join('\n');
}

module.exports = {
  PREFIXES,
  commitBump,
  isPullRequestMerge,
  deriveReleaseVersion,
  readReleaseVersion,
  hasUncommittedChanges,
  releaseVersionName,
  commitMessageProblem,
  majorOf,
};
