import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '@uns-kit/core';
import { classifyExportError } from '../src/temperature-catalog.js';
import { ExportError } from '../src/temperature-history.js';

test('source authorization refusal stays distinct from a service failure without reflecting upstream bodies', () => {
  for (const code of [401, 403]) {
    const result = classifyExportError(new ClientError('private body, SQL and token', code));
    assert.equal(result.status, code);
    assert.ok(!result.message.includes('private'));
    assert.ok(!result.message.includes('token'));
  }
});

test('upstream faults stay safe and local range validation keeps its status', () => {
  assert.equal(classifyExportError(new ClientError('secret', 500)).status, 502);
  assert.equal(classifyExportError(new Error('secret')).status, 502);
  assert.deepEqual(classifyExportError(new ExportError('Choose a smaller range.', 413)), { status: 413, message: 'Choose a smaller range.' });
});
