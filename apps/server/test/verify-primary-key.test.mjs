import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRIMARY_KEY_METADATA_QUERY,
  isExpectedSmokePrimaryKey,
} from '../scripts/verify-primary-key.mjs';

const validPrimaryKey = {
  constraintId: '16384',
  constraintName: 'infrastructure_smoke_probe_pkey',
  columns: ['probe_key'],
};

describe('smoke migration primary-key verification', () => {
  it('accepts a primary key on probe_key', () => {
    assert.equal(isExpectedSmokePrimaryKey([validPrimaryKey]), true);
  });

  it('ignores the primary-key constraint name', () => {
    assert.equal(
      isExpectedSmokePrimaryKey([
        { ...validPrimaryKey, constraintName: 'custom_smoke_primary_key' },
      ]),
      true,
    );
  });

  it('rejects no primary key', () => {
    assert.equal(isExpectedSmokePrimaryKey([]), false);
  });

  it('rejects a primary key on another column', () => {
    assert.equal(
      isExpectedSmokePrimaryKey([
        { ...validPrimaryKey, columns: ['last_command_id'] },
      ]),
      false,
    );
  });

  it('rejects a composite primary key', () => {
    assert.equal(
      isExpectedSmokePrimaryKey([
        { ...validPrimaryKey, columns: ['probe_key', 'last_command_id'] },
      ]),
      false,
    );
  });

  it('rejects multiple conflicting primary-key results', () => {
    assert.equal(
      isExpectedSmokePrimaryKey([
        validPrimaryKey,
        {
          constraintId: '16385',
          constraintName: 'conflicting_primary_key',
          columns: ['probe_key'],
        },
      ]),
      false,
    );
  });

  for (const [name, metadata] of [
    ['non-array result', validPrimaryKey],
    ['null row', [null]],
    [
      'PostgreSQL array string',
      [{ ...validPrimaryKey, columns: '{probe_key}' }],
    ],
    ['missing columns', [{ constraintId: '16384', constraintName: 'pkey' }]],
    ['null column', [{ ...validPrimaryKey, columns: [null] }]],
    ['extra metadata', [{ ...validPrimaryKey, indexName: 'unrelated_index' }]],
  ]) {
    it(`rejects unexpected metadata: ${name}`, () => {
      assert.equal(isExpectedSmokePrimaryKey(metadata), false);
    });
  }

  it('queries only primary-key constraints and preserves key ordinality', () => {
    assert.match(
      PRIMARY_KEY_METADATA_QUERY,
      /constraint_record\.contype = 'p'/,
    );
    assert.match(PRIMARY_KEY_METADATA_QUERY, /WITH ORDINALITY/);
    assert.match(PRIMARY_KEY_METADATA_QUERY, /ORDER BY key_column\.ordinality/);
    assert.doesNotMatch(PRIMARY_KEY_METADATA_QUERY, /pg_index|indexdef/);
  });
});
