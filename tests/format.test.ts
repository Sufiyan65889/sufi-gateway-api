import test from 'node:test';
import assert from 'node:assert/strict';
import { dayKeyFor } from '../lib/settings';

test('day key uses the configured timezone', () => {
  const date = new Date('2026-10-25T19:00:00.000Z');
  assert.equal(dayKeyFor('Asia/Kolkata', date), '2026-10-26');
  assert.equal(dayKeyFor('UTC', date), '2026-10-25');
});
