#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_NAMES,
  VALIDATION_SCHEMA,
  classifyChangedFiles,
  computeDomainFingerprint,
  findUnknownOwnedPaths,
} from './validation-domains.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE_PLATFORM = 'ubuntu24-node24';

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function parseLsTree(buffer) {
  const entries = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const metadata = record.slice(0, tab).split(' ');
    entries.push({ path: record.slice(tab + 1), blob: metadata[2] });
  }
  return entries;
}

export function trackedEntries(ref = 'HEAD') {
  return parseLsTree(
    execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', ref], {
      cwd: REPO_ROOT,
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

function changedFilesForPullRequest() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error('GITHUB_EVENT_PATH is required for pull_request planning');
  }
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const baseSha = event.pull_request?.base?.sha;
  const headSha = event.pull_request?.head?.sha;
  if (!baseSha || !headSha) {
    throw new Error('pull_request base/head SHA missing from GitHub event payload');
  }

  const output = git(['diff', '--name-only', '-z', `${baseSha}...${headSha}`]);
  return output.split('\0').filter(Boolean);
}

export function buildPlan({
  eventName,
  changedFiles,
  entries,
  forceAll = eventName !== 'pull_request',
}) {
  const classification = classifyChangedFiles(changedFiles);
  const relevant = forceAll
    ? Object.fromEntries(DOMAIN_NAMES.map((domain) => [domain, true]))
    : classification.relevant;
  const fingerprints = {};
  const cacheKeys = {};

  for (const domain of DOMAIN_NAMES) {
    fingerprints[domain] = computeDomainFingerprint(domain, entries);
    cacheKeys[domain] =
      `ci-validation-v${VALIDATION_SCHEMA}-${CACHE_PLATFORM}-${domain}-${fingerprints[domain]}`;
  }

  return {
    schema: VALIDATION_SCHEMA,
    eventName,
    forceAll,
    relevant,
    fingerprints,
    cacheKeys,
    unknownPaths: classification.unknownPaths,
    classifications: classification.classifications,
  };
}

function appendGithubOutputs(plan) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  const lines = [];
  for (const domain of DOMAIN_NAMES) {
    const key = domain.replaceAll('-', '_');
    lines.push(`${key}_relevant=${plan.relevant[domain]}`);
    lines.push(`${key}_fingerprint=${plan.fingerprints[domain]}`);
    lines.push(`${key}_cache_key=${plan.cacheKeys[domain]}`);
  }
  lines.push(`unknown_paths_json=${JSON.stringify(plan.unknownPaths)}`);
  writeFileSync(outputPath, `${lines.join('\n')}\n`, { flag: 'a' });
}

function printPlan(plan) {
  console.log(
    JSON.stringify(
      {
        schema: plan.schema,
        eventName: plan.eventName,
        forceAll: plan.forceAll,
        relevant: plan.relevant,
        fingerprints: plan.fingerprints,
        cacheKeys: plan.cacheKeys,
        unknownPaths: plan.unknownPaths,
      },
      null,
      2,
    ),
  );

  for (const path of plan.unknownPaths) {
    console.warn(
      `::warning file=${path}::CI domain ownership missing for ${path}; falling back to full validation.`,
    );
  }
}

function checkOwnership() {
  const paths = trackedEntries().map(({ path }) => path);
  const unknown = findUnknownOwnedPaths(paths);
  if (unknown.length === 0) {
    console.log('CI domain ownership covers all tracked executable/config paths.');
    return;
  }
  console.error('CI domain ownership is missing for:');
  for (const path of unknown) {
    console.error(`  - ${path}`);
  }
  process.exitCode = 1;
}

function writeMarker(args) {
  const domain = args[0];
  const fingerprint = args[1];
  const outputPath = args[2];
  if (!DOMAIN_NAMES.includes(domain) || !fingerprint || !outputPath) {
    throw new Error(
      'Usage: plan-validation.mjs mark <domain> <fingerprint> <output-path>',
    );
  }
  const marker = {
    domain,
    fingerprint,
    validatedByRun: process.env.GITHUB_RUN_ID ?? null,
    schema: VALIDATION_SCHEMA,
  };
  mkdirSync(dirname(resolve(REPO_ROOT, outputPath)), { recursive: true });
  writeFileSync(resolve(REPO_ROOT, outputPath), `${JSON.stringify(marker)}\n`);
}

function main() {
  const [mode = 'plan', ...args] = process.argv.slice(2);
  if (mode === 'check-ownership') {
    checkOwnership();
    return;
  }
  if (mode === 'mark') {
    writeMarker(args);
    return;
  }
  if (mode !== 'plan') {
    throw new Error(`Unknown mode: ${mode}`);
  }

  const eventName = process.env.GITHUB_EVENT_NAME ?? 'local';
  const forceAll = eventName !== 'pull_request';
  const changedFiles =
    eventName === 'pull_request'
      ? changedFilesForPullRequest()
      : trackedEntries().map(({ path }) => path);
  const plan = buildPlan({
    eventName,
    changedFiles,
    entries: trackedEntries(),
    forceAll,
  });
  appendGithubOutputs(plan);
  printPlan(plan);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
