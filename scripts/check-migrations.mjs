import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Comments, quoted identifiers and string values are not DDL.
// Dollar bodies are inspected recursively so
// real ALTER statements inside DO/function bodies cannot bypass the policy.
function visibleSql(sql) {
  let result = '', i = 0;
  while (i < sql.length) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end; result += ' '; continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      result += ' '; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]; let closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        if (sql[i] === '\\' && quote === "'") i++;
        i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      result += quote === '"' ? ' identifier ' : ' '; continue;
    }
    const dollar = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      if (end < 0) throw new Error('Unterminated SQL function body');
      result += ' ' + visibleSql(sql.slice(i + dollar[0].length, end)) + ' ';
      i = end + dollar[0].length; continue;
    }
    result += sql[i++];
  }
  return result;
}

export function inspectMigration(sql) {
  let visible;
  try { visible = visibleSql(sql); } catch (error) { return [error.message]; }
  const issues = [];
  const addsNotNull = visible.split(';').some(statement => /\bALTER\s+TABLE\b[\s\S]*\bADD\s+(?:COLUMN\s+)?(?!(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b)[\s\S]*\bNOT\s+NULL\b/i.test(statement));
  if (addsNotNull && /\bDROP\b/i.test(visible)) issues.push('Separate ADD NOT NULL and destructive DROP into expand/contract migrations');
  if (/\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bREINDEX\b[^;]*\bCONCURRENTLY\b/i.test(visible)) issues.push('CONCURRENTLY must run outside transactional Drizzle migrations using the manual DDL runbook');
  return issues;
}

export function checkMigrations(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const folder = path.join(root, 'packages/persistence/drizzle');
  const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/migration-policy-baseline.json'), 'utf8'));
  const files = readdirSync(folder).filter(file => file.endsWith('.sql')).sort();
  const issues = [];
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')).entries;
  const registered = journal.map(entry => `${entry.tag}.sql`);
  if (new Set(registered).size !== registered.length) issues.push('Migration journal contains duplicate entries');
  for (const file of files) if (!registered.includes(file)) issues.push(`${file}: migration is not registered`);
  for (const file of registered) if (!files.includes(file)) issues.push(`${file}: registered migration is missing`);
  for (let i = 1; i < journal.length; i++) if (journal[i].when <= journal[i - 1].when) issues.push('Migration journal timestamps must increase');
  for (const file of Object.keys(baseline)) if (!files.includes(file)) issues.push(`${file}: historical migration was removed`);
  for (const file of files) {
    const sql = readFileSync(path.join(folder, file), 'utf8');
    // Git checkouts can use CRLF; existing migration bytes are otherwise immutable.
    const hash = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    if (baseline[file]) {
      if (baseline[file] !== hash) issues.push(`${file}: historical migration changed; create a new migration`);
    } else for (const issue of inspectMigration(sql)) issues.push(`${file}: ${issue}`);
  }
  return { checked: files.length, baseline: Object.keys(baseline).length, issues };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkMigrations();
  if (result.issues.length) { for (const issue of result.issues) process.stderr.write(issue + '\n'); process.exitCode = 1; }
  else process.stdout.write(`Migration policy passed: ${result.checked} files, ${result.baseline} immutable historical files.\n`);
}
