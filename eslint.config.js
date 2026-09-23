// eslint.config.js

import { defineConfig } from 'eslint/config';
import tsParser from '@typescript-eslint/parser';

export default defineConfig([
  // Apply to all source and test files
  {
    files: ['src/**/*', 'test/**/*'],
    ignores: ['dist/', 'node_modules/'], // Folders to ignore
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest', // Use latest ECMAScript version
        sourceType: 'module', // Enable ES modules
      },
    },
    rules: {
      semi: ['warn', 'always'],
    },
  },

  // Override specifically for test files
  {
    files: ['test/**/*'],
    rules: {
      'no-console': 'off',
    },
  },

  // Additional configurations can go here
]);
