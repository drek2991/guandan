import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseInfrastructureDatabaseSmokeAcknowledgement,
  parseInfrastructureDatabaseSmokeCommand,
} from '../src/index.js';

const COMMAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const PROBE_TOKEN = '8f14e45f-ea1e-4b29-bad7-6e7f5f541234';

const validCommand = {
  commandId: COMMAND_ID,
  probeToken: PROBE_TOKEN,
};

const validSuccess = {
  status: 'ok',
  commandId: COMMAND_ID,
  probeToken: PROBE_TOKEN,
  databaseVerified: true,
  operation: 'upsert-readback',
  databaseUpdatedAt: '2026-07-27T12:00:00.000Z',
  completedAt: '2026-07-27T12:00:01.000Z',
};

const validFailure = {
  status: 'error',
  code: 'DATABASE_UNAVAILABLE',
  message: 'Database is unavailable',
  commandId: COMMAND_ID,
};

describe('infrastructure database smoke command', () => {
  it('accepts a command with exact UUID v4 identifiers', () => {
    assert.deepEqual(
      parseInfrastructureDatabaseSmokeCommand(validCommand),
      validCommand,
    );
  });

  for (const [name, command] of [
    [
      'invalid command identifier',
      { ...validCommand, commandId: 'not-a-uuid' },
    ],
    ['invalid probe token', { ...validCommand, probeToken: 'not-a-uuid' }],
    ['missing command identifier', { probeToken: PROBE_TOKEN }],
    ['missing probe token', { commandId: COMMAND_ID }],
    ['unexpected field', { ...validCommand, database: 'unsupported' }],
    ['array payload', [validCommand]],
    ['null payload', null],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(parseInfrastructureDatabaseSmokeCommand(command), undefined);
    });
  }
});

describe('infrastructure database smoke acknowledgement', () => {
  it('accepts the exact success shape', () => {
    assert.deepEqual(
      parseInfrastructureDatabaseSmokeAcknowledgement(validSuccess),
      validSuccess,
    );
  });

  it('accepts structured failures with and without command identifiers', () => {
    assert.deepEqual(
      parseInfrastructureDatabaseSmokeAcknowledgement(validFailure),
      validFailure,
    );
    assert.deepEqual(
      parseInfrastructureDatabaseSmokeAcknowledgement({
        status: 'error',
        code: 'INVALID_PAYLOAD',
        message: 'Invalid smoke command payload',
      }),
      {
        status: 'error',
        code: 'INVALID_PAYLOAD',
        message: 'Invalid smoke command payload',
      },
    );
  });

  for (const [name, acknowledgement] of [
    [
      'success with a malformed identifier',
      { ...validSuccess, commandId: 'invalid' },
    ],
    [
      'success without database verification',
      { ...validSuccess, databaseVerified: false },
    ],
    [
      'success with an invalid timestamp',
      { ...validSuccess, databaseUpdatedAt: 'yesterday' },
    ],
    ['success with an extra field', { ...validSuccess, revision: 1 }],
    [
      'failure with an unsupported code',
      { ...validFailure, code: 'SQL_ERROR' },
    ],
    ['failure with an empty message', { ...validFailure, message: '' }],
    [
      'failure with an invalid command identifier',
      { ...validFailure, commandId: 'invalid' },
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      assert.equal(
        parseInfrastructureDatabaseSmokeAcknowledgement(acknowledgement),
        undefined,
      );
    });
  }
});
