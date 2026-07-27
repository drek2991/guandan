import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readConfig, type ServerEnvironment } from '../src/config.js';

const CREDENTIAL_MARKER = 'fixture-credential-marker';

function createDatabaseUrl(customize?: (url: URL) => void): string {
  const url = new URL('postgresql://db.example.invalid/postgres');
  url.username = 'fixture-user';
  url.password = CREDENTIAL_MARKER;
  url.searchParams.set('sslmode', 'require');
  customize?.(url);
  return url.href;
}

function createEnvironment(
  overrides: Partial<ServerEnvironment> = {},
): ServerEnvironment {
  return {
    DATABASE_CA_PATH: '.certs/test-ca.crt',
    DATABASE_URL: createDatabaseUrl(),
    ...overrides,
  };
}

describe('server configuration', () => {
  it('uses the default port and deployment-compatible binding', () => {
    const config = readConfig(createEnvironment());

    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.port, 3000);
  });

  it('accepts a valid custom port', () => {
    const config = readConfig(createEnvironment({ PORT: '4321' }));

    assert.equal(config.port, 4321);
  });

  for (const port of ['', '0', '65536', '12.5', 'not-a-number']) {
    it(`rejects invalid PORT=${JSON.stringify(port)}`, () => {
      assert.throws(
        () => readConfig(createEnvironment({ PORT: port })),
        /PORT must be an integer between 1 and 65535/,
      );
    });
  }

  for (const nodeEnv of ['development', 'production', 'test'] as const) {
    it(`accepts NODE_ENV=${nodeEnv}`, () => {
      const config = readConfig(createEnvironment({ NODE_ENV: nodeEnv }));

      assert.equal(config.nodeEnv, nodeEnv);
    });
  }

  it('rejects an unsupported NODE_ENV', () => {
    assert.throws(
      () => readConfig(createEnvironment({ NODE_ENV: 'staging' })),
      /NODE_ENV must be development, production, or test/,
    );
  });

  it('requires DATABASE_URL', () => {
    assert.throws(() => readConfig({}), /DATABASE_URL is required/);
    assert.throws(
      () => readConfig({ DATABASE_URL: '' }),
      /DATABASE_URL is required/,
    );
  });

  it('requires a CA certificate path', () => {
    assert.throws(
      () => readConfig({ DATABASE_URL: createDatabaseUrl() }),
      /DATABASE_CA_PATH is required/,
    );
    assert.throws(
      () =>
        readConfig({
          DATABASE_CA_PATH: ' .certs/ca.crt ',
          DATABASE_URL: createDatabaseUrl(),
        }),
      /DATABASE_CA_PATH must not contain surrounding whitespace/,
    );
  });

  it('accepts postgres and postgresql protocols with SSL required', () => {
    for (const protocol of ['postgres:', 'postgresql:']) {
      const value = createDatabaseUrl((url) => {
        url.protocol = protocol;
      });

      const connectionString = readConfig({
        DATABASE_CA_PATH: '.certs/test-ca.crt',
        DATABASE_URL: value,
      }).database.connectionString;

      assert.equal(
        new URL(connectionString).searchParams.has('sslmode'),
        false,
      );
    }
  });

  it('rejects invalid URL syntax without exposing credentials', () => {
    assertSanitizedConfigurationError(
      `${CREDENTIAL_MARKER} is not a URL`,
      /valid PostgreSQL URL/,
    );
  });

  it('rejects non-PostgreSQL protocols', () => {
    const url = new URL('https://db.example.invalid/postgres');
    url.username = 'fixture-user';
    url.password = CREDENTIAL_MARKER;
    url.searchParams.set('sslmode', 'require');

    assertSanitizedConfigurationError(url.href, /postgres: or postgresql:/);
  });

  it('requires all connection URL components', () => {
    const variants = [
      (url: URL) => {
        url.username = '';
      },
      (url: URL) => {
        url.password = '';
      },
      (url: URL) => {
        url.pathname = '/';
      },
    ];

    variants.forEach((customize) => {
      assertSanitizedConfigurationError(
        createDatabaseUrl(customize),
        /must include a username, password, host, and database name/,
      );
    });
  });

  it('accepts a missing sslmode because the pool enforces SSL', () => {
    const value = createDatabaseUrl((url) => {
      url.searchParams.delete('sslmode');
    });

    assert.doesNotThrow(() =>
      readConfig({
        DATABASE_CA_PATH: '.certs/test-ca.crt',
        DATABASE_URL: value,
      }),
    );
  });

  it('rejects conflicting or duplicate sslmode parameters', () => {
    const variants = [
      (url: URL) => {
        url.searchParams.set('sslmode', 'disable');
      },
      (url: URL) => {
        url.searchParams.append('sslmode', 'require');
      },
    ];

    variants.forEach((customize) => {
      assertSanitizedConfigurationError(
        createDatabaseUrl(customize),
        /sslmode must be absent or appear once with the value require/,
      );
    });
  });

  it('rejects unsupported SSL parameters', () => {
    for (const parameter of [
      'uselibpqcompat',
      'sslcert',
      'sslkey',
      'sslrootcert',
    ]) {
      const value = createDatabaseUrl((url) => {
        url.searchParams.set(parameter, 'fixture');
      });

      assertSanitizedConfigurationError(value, /unsupported SSL parameters/);
    }
  });

  it('rejects surrounding whitespace', () => {
    assertSanitizedConfigurationError(
      ` ${createDatabaseUrl()} `,
      /must not contain surrounding whitespace/,
    );
  });
});

function assertSanitizedConfigurationError(
  databaseUrl: string,
  expectedMessage: RegExp,
): void {
  assert.throws(
    () =>
      readConfig({
        DATABASE_CA_PATH: '.certs/test-ca.crt',
        DATABASE_URL: databaseUrl,
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expectedMessage);
      assert.equal(error.message.includes(CREDENTIAL_MARKER), false);
      return true;
    },
  );
}
