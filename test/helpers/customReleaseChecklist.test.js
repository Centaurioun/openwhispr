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
});
