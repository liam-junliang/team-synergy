// ESLint flat config（评审 docs/30 工程化缺漏 #1）。
// 基线原则：先保证"正确性 + 一致性"，不做风格强制（交给 prettier，另行接入）。
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.mjs', // 测试为纯 JavaScript（node:test），基线阶段不覆盖
      'prototype-ui/**',
      'prototype-design/**',
      '.tmp/**',
      '.worktrees/**',
      '.omx/**',
      '.reasonix/**',
      '.agent/**',
      'tmp/**',
      'output/**',
      'assets/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // ---- 正确性：一律报错 ----
      'no-console': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'smart'],

      // ---- TypeScript 已兜底的规则：关闭避免噪音 ----
      'no-undef': 'off',

      // ---- 基线暂告警（后续逐步清零）----
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'prefer-const': 'warn',
    },
  },
  {
    files: ['apps/web/src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
);
