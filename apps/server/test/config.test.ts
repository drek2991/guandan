import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConfig } from '../src/config.js';

describe('server configuration', () => {
  it('uses the default port and deployment-compatible binding', () => {
    assert.deepEqual(readConfig({}), {
      host: '0.0.0.0',
      port: 3000,
    });
  });

  it('accepts a valid custom port', () => {
    assert.deepEqual(readConfig({ PORT: '4321' }), {
      host: '0.0.0.0',
      port: 4321,
    });
  });

  for (const port of ['', '0', '65536', '12.5', 'not-a-number']) {
    it(`rejects invalid PORT=${JSON.stringify(port)}`, () => {
      assert.throws(
        () => readConfig({ PORT: port }),
        /PORT must be an integer between 1 and 65535/,
      );
    });
  }

  for (const nodeEnv of ['development', 'production', 'test'] as const) {
    it(`accepts NODE_ENV=${nodeEnv}`, () => {
      assert.deepEqual(readConfig({ NODE_ENV: nodeEnv }), {
        host: '0.0.0.0',
        nodeEnv,
        port: 3000,
      });
    });
  }

  it('rejects an unsupported NODE_ENV', () => {
    assert.throws(
      () => readConfig({ NODE_ENV: 'staging' }),
      /NODE_ENV must be development, production, or test/,
    );
  });
});
