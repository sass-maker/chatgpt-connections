#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(message) {
  console.error(`deploy blocked: ${message}`);
  process.exit(1);
}

function githubSlug() {
  const url = run('git', ['remote', 'get-url', 'origin']);
  if (url.startsWith('git@github.com:')) {
    return url.slice('git@github.com:'.length).replace(/\.git$/, '');
  }
  if (url.startsWith('https://github.com/')) {
    return url.slice('https://github.com/'.length).replace(/\.git$/, '');
  }
  fail(`origin remote is not a GitHub URL: ${url}`);
}

function verifyGitState() {
  const branch = run('git', ['branch', '--show-current']);
  if (branch !== 'main') fail(`current branch is ${branch || 'DETACHED'}, expected main`);
  if (run('git', ['status', '--porcelain'])) fail('working tree is dirty');

  run('git', ['fetch', '--quiet', 'origin']);
  const upstream = run('git', [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  const [behind, ahead] = run('git', [
    'rev-list',
    '--left-right',
    '--count',
    `${upstream}...HEAD`,
  ]).split(/\s+/).map(Number);
  if (behind !== 0 || ahead !== 0) {
    fail(`branch is not synced with ${upstream}: ahead ${ahead}, behind ${behind}`);
  }
}

function verifyCi(slug, sha) {
  let runs;
  try {
    runs = JSON.parse(run('gh', [
      'run',
      'list',
      '-R',
      slug,
      '--workflow',
      'ci.yml',
      '--branch',
      'main',
      '--limit',
      '20',
      '--json',
      'status,conclusion,headSha,url',
    ]));
  } catch {
    fail('could not read ci.yml runs from GitHub');
  }
  const successful = runs.find((candidate) =>
    candidate.status === 'completed'
    && candidate.conclusion === 'success'
    && candidate.headSha === sha);
  if (!successful) fail(`no successful ci.yml run found for ${sha}`);
}

verifyGitState();
try {
  run('gh', ['auth', 'status']);
} catch {
  fail('gh is not authenticated');
}

const sha = run('git', ['rev-parse', 'HEAD']);
verifyCi(githubSlug(), sha);

const result = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'deploy', '--tag', sha],
  { cwd: root, env: process.env, stdio: 'inherit' },
);
if (result.error) fail(result.error.message);
if (result.status !== 0) fail(`pnpm exec wrangler deploy exited with status ${result.status}`);
