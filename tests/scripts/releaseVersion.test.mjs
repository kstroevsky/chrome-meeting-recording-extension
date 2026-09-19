import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  commitBump,
  deriveReleaseVersion,
  readReleaseVersion,
  hasUncommittedChanges,
  releaseVersionName,
  commitMessageProblem,
} = require('../../scripts/lib/releaseVersion.cjs');
const { compareChromeVersions } = require('../../scripts/lib/manifestVersion.cjs');

test('commit prefixes map to the segment they bump', () => {
  assert.equal(commitBump('Feature: Record in any tab'), 'c');
  assert.equal(commitBump('feat(popup): prompt for recording names'), 'c');
  assert.equal(commitBump('FIX: crash on stop'), 'd');
  assert.equal(commitBump('Refactor: Split the popup'), 'd');
  assert.equal(commitBump('Perf: Fewer attribute writes'), 'd');
  assert.equal(commitBump('Draft: Pixel-perfect layout'), 'd');
  assert.equal(commitBump('Revert "Feature: Record in any tab"'), 'd');
  assert.equal(commitBump('fixup! Feature: Record in any tab'), 'c');
  assert.equal(commitBump('Testing: Notations'), 'none');
  assert.equal(commitBump('test(e2e): cover post-upload rename'), 'none');
  assert.equal(commitBump('Docs: Update outdated documentation'), 'none');
});

test('unknown prefixes bump nothing', () => {
  assert.equal(commitBump('Update README'), null);
  assert.equal(commitBump('First commit'), null);
  assert.equal(commitBump('Fixes: typo'), null); // the prefix is a whole word
  assert.equal(commitBump('constructor: not an object key'), null);
});

const commit = (subject) => ({ subject, merge: false });
const merge = (subject) => ({ subject, merge: true });

test('d counts only the fixes after the newest feature', () => {
  const firstParent = [commit('Fix: b'), commit('Feature: a'), commit('Fix: older'), commit('Refactor: older')];
  assert.equal(deriveReleaseVersion({ major: 0, mergeSubjects: [], firstParent }), '0.0.1.1');
});

test('a merged pull request resets c and d', () => {
  const pr = 'Merge pull request #2 from me/feat/b';
  const firstParent = [commit('Fix: after'), merge(pr), commit('Feature: already folded into #1')];
  const mergeSubjects = [pr, 'Merge pull request #1 from me/feat/a'];
  assert.equal(deriveReleaseVersion({ major: 3, mergeSubjects, firstParent }), '3.2.0.1');
});

test('merging main into a branch is not a pull request', () => {
  const sync = "Merge branch 'main' into feat/y";
  const firstParent = [commit('Fix: y2'), merge(sync), commit('Feature: y1'), merge('Merge pull request #1 from me/x')];
  const mergeSubjects = [
    sync,
    "Merge remote-tracking branch 'origin/main' into feat/y",
    "Merge branch 'main' of github.com:me/repo",
    'Merge pull request #1 from me/x',
  ];
  assert.equal(deriveReleaseVersion({ major: 0, mergeSubjects, firstParent }), '0.1.1.1');
});

test('the display name says how a build differs from its commit', () => {
  assert.equal(releaseVersionName('0.3.1.2'), '0.3.1.2');
  assert.equal(releaseVersionName('0.3.1.2', { dev: true }), '0.3.1.2 (dev)');
  assert.equal(releaseVersionName('0.3.1.2', { dev: true, dirty: true }), '0.3.1.2 (dev, uncommitted changes)');
  assert.equal(releaseVersionName('0.0.0.0', { dev: true, fromGit: false }), '0.0.0.0 (dev, no git history)');
});

test('the commit-msg check accepts known prefixes and merges, and explains a refusal', () => {
  assert.equal(commitMessageProblem('Feature: A thing\n\nBody text'), null);
  assert.equal(commitMessageProblem('# Please enter the commit message\nfix(popup): hover'), null);
  assert.equal(commitMessageProblem("Merge branch 'feat/x'"), null);
  assert.equal(commitMessageProblem('Revert "Fix: something"'), null);
  assert.equal(commitMessageProblem(''), null);
  const problem = commitMessageProblem('Update things');
  assert.match(problem, /"Update things" does not start with a known prefix/);
  assert.match(problem, /Feature:/);
});

// --- Against a real repository ------------------------------------------------

function makeRepo(t, firstMajor = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const setMajor = (major) =>
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version: `${major}.0.0` }, null, 2)}\n`);
  let files = 0;
  // One new file per commit, so branches never conflict when merged.
  const commitAs = (subject) => {
    fs.writeFileSync(path.join(dir, `change-${files += 1}.txt`), `${subject}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', subject);
  };
  const mergeAs = (branch, subject) => git('merge', '-q', '--no-ff', '-m', subject, branch);
  const version = (rev = 'HEAD') => readReleaseVersion({ cwd: dir, rev });
  git('init', '-q', '-b', 'main');
  setMajor(firstMajor);
  commitAs('First commit');
  return { dir, git, setMajor, commitAs, mergeAs, version };
}

test('a branch counts its own work, and its merge folds that into b', (t) => {
  const repo = makeRepo(t);
  assert.equal(repo.version(), '0.0.0.0');
  repo.commitAs('Feature: a');
  repo.commitAs('Fix: b');
  assert.equal(repo.version(), '0.0.1.1');

  repo.git('checkout', '-q', '-b', 'feat/x');
  repo.commitAs('Feature: x1');
  repo.commitAs('Fix: x2');
  assert.equal(repo.version(), '0.0.2.1');

  repo.git('checkout', '-q', 'main');
  repo.commitAs('Fix: on main meanwhile');
  assert.equal(repo.version(), '0.0.1.2');
  repo.mergeAs('feat/x', 'Merge pull request #1 from me/feat/x');
  assert.equal(repo.version(), '0.1.0.0');

  repo.commitAs('Fix: after');
  assert.equal(repo.version(), '0.1.0.1');
  repo.commitAs('Feature: after');
  assert.equal(repo.version(), '0.1.1.0');
  repo.commitAs('Docs: no bump');
  assert.equal(repo.version(), '0.1.1.0');
});

test('a branch that merged main in counts main\'s pull requests, and main never goes down', (t) => {
  const repo = makeRepo(t);
  repo.commitAs('Feature: base');
  repo.git('checkout', '-q', '-b', 'feat/y');
  repo.commitAs('Feature: y1');
  assert.equal(repo.version(), '0.0.2.0');

  repo.git('checkout', '-q', 'main');
  repo.git('checkout', '-q', '-b', 'feat/z');
  repo.commitAs('Fix: z1');
  repo.git('checkout', '-q', 'main');
  repo.mergeAs('feat/z', 'Merge pull request #1 from me/feat/z');
  assert.equal(repo.version(), '0.1.0.0');

  repo.git('checkout', '-q', 'feat/y');
  repo.mergeAs('main', "Merge branch 'main' into feat/y");
  // b sees #1 through the sync merge; the sync merge itself resets nothing.
  assert.equal(repo.version(), '0.1.2.0');
  repo.commitAs('Fix: y2');
  assert.equal(repo.version(), '0.1.2.1');

  repo.git('checkout', '-q', 'main');
  repo.mergeAs('feat/y', 'Merge pull request #2 from me/feat/y');
  assert.equal(repo.version(), '0.2.0.0');

  const history = repo.git('log', '--first-parent', '--format=%H', 'main').trim().split('\n').reverse();
  const versions = history.map((rev) => repo.version(rev));
  for (let i = 1; i < versions.length; i += 1) {
    assert.ok(compareChromeVersions(versions[i], versions[i - 1]) >= 0, `${versions[i - 1]} -> ${versions[i]}`);
  }
});

test('raising the major through a pull request starts b, c and d over', (t) => {
  const repo = makeRepo(t);
  repo.git('checkout', '-q', '-b', 'feat/a');
  repo.commitAs('Feature: a');
  repo.git('checkout', '-q', 'main');
  repo.mergeAs('feat/a', 'Merge pull request #1 from me/feat/a');
  assert.equal(repo.version(), '0.1.0.0');

  repo.git('checkout', '-q', '-b', 'release/one');
  repo.setMajor(1);
  repo.commitAs('Release: 1.0');
  assert.equal(repo.version(), '1.0.0.0');

  repo.git('checkout', '-q', 'main');
  repo.mergeAs('release/one', 'Merge pull request #2 from me/release/one');
  assert.equal(repo.version(), '1.0.0.0');
  repo.commitAs('Fix: after the new major');
  assert.equal(repo.version(), '1.0.0.1');
});

test('a lowered major does not start counting over', (t) => {
  const repo = makeRepo(t, 1);
  repo.git('checkout', '-q', '-b', 'feat/a');
  repo.commitAs('Feature: a');
  repo.git('checkout', '-q', 'main');
  repo.mergeAs('feat/a', 'Merge pull request #1 from me/feat/a');
  repo.setMajor(0);
  repo.commitAs('Setup: back to pre-release');
  assert.equal(repo.version(), '0.1.0.0');
});

test('an uncommitted major is a.0.0.0, and the tree reads as dirty', (t) => {
  const repo = makeRepo(t);
  repo.commitAs('Feature: a');
  assert.equal(hasUncommittedChanges(repo.dir), false);
  repo.setMajor(2);
  assert.equal(readReleaseVersion({ cwd: repo.dir, packageVersion: '2.0.0' }), '2.0.0.0');
  assert.equal(hasUncommittedChanges(repo.dir), true);
});

test('a shallow clone refuses to count', (t) => {
  const repo = makeRepo(t);
  repo.commitAs('Feature: a');
  const clone = `${repo.dir}-shallow`;
  t.after(() => fs.rmSync(clone, { recursive: true, force: true }));
  repo.git('clone', '-q', '--depth', '1', `file://${repo.dir}`, clone);
  assert.throws(() => readReleaseVersion({ cwd: clone }), /shallow clone/);
});
