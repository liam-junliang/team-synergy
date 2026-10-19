import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../../packages/persistence/drizzle');
const dst = path.resolve(here, '../dist/migrations');
cpSync(src, dst, { recursive: true });
console.log(`migrations copied: ${src} -> ${dst}`);
