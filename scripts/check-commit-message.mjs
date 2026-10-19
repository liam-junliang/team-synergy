#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TYPES = new Set([
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test',
  'build', 'ci', 'chore', 'revert',
]);

const PATTERN = /^(?<type>[a-z]+)(?:\((?<scope>[a-z0-9][a-z0-9-]*)\))?(?<breaking>!)?: (?<subject>.+)$/;

function readMessage(argv) {
  const fileIndex = argv.indexOf('--file');
  if (fileIndex !== -1) {
    const file = argv[fileIndex + 1];
    if (!file) throw new Error('--file requires a path');
    return readFileSync(file, 'utf8');
  }
  const messageIndex = argv.indexOf('--message');
  if (messageIndex !== -1) {
    const message = argv[messageIndex + 1];
    if (message === undefined) throw new Error('--message requires text');
    return message;
  }
  const revIndex = argv.indexOf('--rev');
  const rev = revIndex !== -1 ? argv[revIndex + 1] : 'HEAD';
  return execFileSync('git', ['log', '-1', '--format=%B', rev], { encoding: 'utf8' });
}

function validate(message) {
  const title = message.split(/\r?\n/, 1)[0].trim();
  if (/^(Merge |Revert "|fixup! |squash! )/.test(title)) return null;

  const match = PATTERN.exec(title);
  if (!match) return 'expected "<type>(<scope>): <subject>"';
  const { type, scope, subject } = match.groups;
  if (!TYPES.has(type)) return `unsupported type "${type}"`;
  if (scope && scope !== scope.toLowerCase()) return 'scope must be lowercase';
  if (!subject.trim()) return 'subject is empty';
  if (subject.length > 72) return `subject is ${subject.length} characters (max 72)`;
  if (/[.。]$/.test(subject)) return 'subject must not end with a period';
  return null;
}

try {
  const message = readMessage(process.argv.slice(2));
  const error = validate(message);
  if (error) {
    console.error(`Invalid commit message: ${error}`);
    console.error(`Got: ${message.split(/\r?\n/, 1)[0]}`);
    console.error('Expected: <type>(<scope>): <subject>');
    console.error(`Types: ${[...TYPES].join(', ')}`);
    console.error('Example: fix(web): keep document header sticky while scrolling');
    process.exit(1);
  }
} catch (error) {
  console.error(`Commit message check failed: ${error.message}`);
  process.exit(1);
}
