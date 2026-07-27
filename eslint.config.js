const eslint = require('@eslint/js');
const prettier = require('eslint-config-prettier/flat');
const expo = require('eslint-config-expo/flat');
const globals = require('globals');
const tseslint = require('typescript-eslint');

const nodeTestSafeCalls = [
  { from: 'package', name: 'after', package: 'node:test' },
  { from: 'package', name: 'before', package: 'node:test' },
  { from: 'package', name: 'describe', package: 'node:test' },
  { from: 'package', name: 'it', package: 'node:test' },
];

const typedTestRules = {
  '@typescript-eslint/no-floating-promises': [
    'error',
    { allowForKnownSafeCalls: nodeTestSafeCalls },
  ],
};

const typedTypeScriptRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      ignoreRestSiblings: true,
      varsIgnorePattern: '^_',
    },
  ],
};

module.exports = tseslint.config(
  {
    ignores: [
      '**/.expo/**',
      '**/build/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/web-build/**',
      'apps/mobile/expo-env.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...expo,
  {
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.jsx', '.ts', '.tsx'],
        },
        typescript: {
          alwaysTryTypes: true,
          project: [
            './apps/mobile/tsconfig.json',
            './apps/mobile/tsconfig.test.json',
            './apps/server/tsconfig.json',
            './apps/server/tsconfig.test.json',
            './packages/game-domain/tsconfig.json',
            './packages/protocol/tsconfig.json',
            './packages/protocol/tsconfig.test.json',
          ],
        },
      },
    },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: './apps/mobile/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: typedTypeScriptRules,
  },
  {
    files: ['apps/mobile/test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './apps/mobile/tsconfig.test.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...typedTypeScriptRules,
      ...typedTestRules,
    },
  },
  {
    files: ['apps/server/src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './apps/server/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: typedTypeScriptRules,
  },
  {
    files: ['apps/server/test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './apps/server/tsconfig.test.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...typedTypeScriptRules,
      ...typedTestRules,
    },
  },
  {
    files: ['packages/protocol/test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: './packages/protocol/tsconfig.test.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...typedTypeScriptRules,
      ...typedTestRules,
    },
  },
  {
    files: ['packages/game-domain/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './packages/game-domain/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: typedTypeScriptRules,
  },
  {
    files: ['packages/protocol/src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './packages/protocol/tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      ...typedTypeScriptRules,
      '@typescript-eslint/no-empty-object-type': [
        'error',
        {
          allowInterfaces: 'always',
        },
      ],
    },
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettier,
);
