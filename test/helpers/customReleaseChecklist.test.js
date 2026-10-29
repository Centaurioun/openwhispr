const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const checklistPath = path.join(__dirname, '../../docs/custom/release-checklist.md');

test('custom release checklist names every GO and NO-GO gate', () => {
  const checklist = fs.readFileSync(checklistPath, 'utf8');

  for (const gate of [
    'GO',
    'NO-GO',
    'clean branch',
    'green tests',
    'source transcription',
    'transcript editor',
    'note summary',
    'original/edited export',
    'MCP read access',
    'sign-in regression',
    'blocker',
  ]) {
    assert.ok(checklist.toLowerCase().includes(gate.toLowerCase()), `missing release gate: ${gate}`);
  }

  assert.match(
    checklist,
    /\*\*GO\*\* only when all eight gates above are checked, evidence is attached, and a human release reviewer records explicit sign-off for this exact candidate\./i,
    'GO must require every gate, attached evidence, and human sign-off for the exact candidate',
  );
  assert.match(
    checklist,
    /\*\*NO-GO\*\* if any evidence is incomplete, missing, ambiguous, or failed\. Record the specific blocker/i,
    'NO-GO must cover all incomplete-evidence states and require a specific blocker',
  );
});
