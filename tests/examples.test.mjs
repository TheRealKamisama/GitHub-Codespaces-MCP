import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { jobSubmitInput } from '../dist/contracts.js';

const directory = new URL('../examples/jobs/', import.meta.url);
const names = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();

test('every example job is a valid job_submit plan with honest verification metadata', async () => {
  assert.ok(names.length >= 10);
  for (const name of names) {
    const example = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    assert.deepEqual(Object.keys(example).filter(k => !['title', 'demonstrates', 'requires', 'checkedIn', 'expect', 'plan'].includes(k)), [], name);
    assert.ok(example.title && example.demonstrates.length && example.requires.length, name);
    assert.ok(['linux-container', 'schema-only'].includes(example.checkedIn), name);
    // Only examples that a test actually runs may promise an outcome.
    assert.equal('expect' in example, example.checkedIn === 'linux-container', name);
    const parsed = jobSubmitInput.safeParse({ projectId: 'dev/example', requestId: 'example-1', source: { ref: 'refs/heads/main', commit: 'a'.repeat(40) }, ...example.plan });
    assert.equal(parsed.success, true, `${name}: ${parsed.error?.message}`);
    for (const step of parsed.data.steps) assert.ok(['command', 'shell'].includes(step.kind), `${name}: no tool-specific step kinds`);
  }
});
