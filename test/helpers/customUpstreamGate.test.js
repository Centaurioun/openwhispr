const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const repoRoot = path.resolve(__dirname, '../..');
const workflowPath = path.join(repoRoot, '.github/workflows/custom-integration.yml');

function readWorkflow() {
  return yaml.load(fs.readFileSync(workflowPath, 'utf8'));
}

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

test('custom integration workflow runs the required regression checks', () => {
  const workflow = readWorkflow();
  const allRunCommands = Object.values(workflow.jobs)
    .flatMap((job) => job.steps || [])
    .map((step) => step.run)
    .filter(Boolean);

  for (const command of [
    'npm test',
    'npm run typecheck',
    'npm run lint',
    'npm run i18n:check',
    'npm run build:renderer',
  ]) {
    assert.ok(
      allRunCommands.some((run) => run.trim() === command),
      `missing required check: ${command}`
    );
  }
});

test('custom integration checks fail closed and cover custom branches', () => {
  const workflow = readWorkflow();
  const pullRequest = workflow.on?.pull_request;
  const branches = pullRequest?.branches || [];
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps || []);

  assert.ok(branches.includes('custom/main'), 'custom/main must be covered');
  assert.ok(
    branches.some((branch) => branch.includes('*') || branch === 'main'),
    'feature branches must be covered'
  );
  assert.ok(
    steps.every((step) => step['continue-on-error'] !== true),
    'required checks must not be allowed to fail'
  );
  assert.ok(
    steps.some((step) => step.uses?.startsWith('actions/setup-node@')),
    'workflow must set up Node'
  );
  assert.ok(
    steps.some((step) => step.run?.includes('npm ci')),
    'workflow must install from the lockfile'
  );
  assert.ok(
    !steps.some((step) => /\b(release|deploy|publish)\b/i.test(step.run || '')),
    'integration workflow must not release or deploy'
  );
});
