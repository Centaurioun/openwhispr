#!/usr/bin/env node
/**
 * Read-only preflight of the local fork's Git state.
 * A pass means this basic preflight is clean, never that a merge is authorized.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const APPROVED_UPSTREAM = new Set([
  'https://github.com/OpenWhispr/openwhispr.git',
  'https://github.com/OpenWhispr/openwhispr',
  'git@github.com:OpenWhispr/openwhispr.git',
  'ssh://git@github.com/OpenWhispr/openwhispr.git',
]);

/**
 * @param {{currentBranch:string, dirty:boolean, ahead:number, behind:number, upstreamRemote:string|null}} input
 * @returns {{ok:boolean, reasons:string[]}}
 */
export function validateIntegrationState(input) {
  const reasons = [];
  if (
    !input || typeof input.currentBranch !== 'string' || !input.currentBranch.trim() ||
    typeof input.dirty !== 'boolean' ||
    !Number.isSafeInteger(input.ahead) || input.ahead < 0 ||
    !Number.isSafeInteger(input.behind) || input.behind < 0
  ) {
    reasons.push('Invalid or incomplete Git state; no integration may proceed.');
    return { ok: false, reasons };
  }
  if (input.dirty) reasons.push('Uncommitted or untracked changes must be reviewed first.');
  if (!input.upstreamRemote || !APPROVED_UPSTREAM.has(input.upstreamRemote.trim())) {
    reasons.push('Expected OpenWhispr upstream remote is missing or mismatched.');
  }
  if (input.currentBranch === 'main' && input.ahead > 0) {
    reasons.push('Baseline main is ahead of upstream; review divergence before updating.');
  }
  if (input.currentBranch === 'main' && input.behind > 0) {
    reasons.push('Baseline main is behind upstream; use a reviewed integration, not automatic update.');
  }
  return { ok: reasons.length === 0, reasons };
}

function git(...args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

/** Read only. This function never fetches, resets, merges or modifies Git state. */
export function inspectIntegrationState() {
  const currentBranch = git('branch', '--show-current');
  const dirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'));
  let upstreamRemote = null;
  try { upstreamRemote = git('remote', 'get-url', 'upstream'); } catch { /* Missing upstream is checked below. */ }
  let ahead = -1;
  let behind = -1;
  try {
    // A cached upstream/main ref must already exist: this command NEVER fetches.
    const counts = git('rev-list', '--left-right', '--count', 'main...refs/remotes/upstream/main')
      .split(/\s+/).map(Number);
    if (counts.length === 2) [ahead, behind] = counts;
  } catch { /* A missing or stale ref fails closed. */ }
  return { currentBranch, dirty, ahead, behind, upstreamRemote };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const state = inspectIntegrationState();
    const verdict = validateIntegrationState(state);
    const result = { ...state, ...verdict, note: 'Read-only preflight; human-reviewed merge and tests still required.' };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = verdict.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, reasons: [
      'Could not inspect local Git state: ' + String(error?.message ?? error),
    ] }, null, 2));
    process.exitCode = 1;
  }
}
