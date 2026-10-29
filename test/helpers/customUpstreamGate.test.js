const { test } = require('node:test');
const assert = require('node:assert/strict');

async function checker() {
  return import('../../scripts/custom/check-upstream-merge.mjs');
}

const clean = Object.freeze({
  currentBranch: 'feature/fork-safety-2026-10-29',
  dirty: false,
  ahead: 0,
  behind: 0,
  mergeBase: 'abc123',
  upstreamRemote: 'https://github.com/OpenWhispr/openwhispr.git',
});

test('clean feature state is safe for review', async () => {
  const { validateIntegrationState } = await checker();
  assert.deepEqual(validateIntegrationState(clean), { ok: true, reasons: [] });
});

test('dirty working tree blocks integration', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, dirty: true });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /uncommitted/i);
});

test('missing upstream remote fails closed', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, upstreamRemote: null });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /upstream remote/i);
});

test('unexpected upstream URL fails closed', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, upstreamRemote: 'https://github.com/attacker/other.git' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /upstream remote/i);
});

test('baseline ahead of upstream blocks automatic update', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, currentBranch: 'main', ahead: 1 });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /ahead/i);
});

test('baseline behind upstream requires reviewed update', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, currentBranch: 'main', behind: 2 });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /behind/i);
});

test('dirty custom/main blocks integration', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, currentBranch: 'custom/main', dirty: true, mergeBase: 'abc123' });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /uncommitted/i);
});

test('missing merge base fails closed', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, mergeBase: null });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /merge.base/i);
});

test('invalid Git state fails closed', async () => {
  const { validateIntegrationState } = await checker();
  const result = validateIntegrationState({ ...clean, currentBranch: '', ahead: -1 });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(' '), /invalid/i);
});
