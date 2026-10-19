import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../../packages/persistence/drizzle');
const destination = path.resolve(here, '../dist/migrations');

cpSync(source, destination, { recursive: true });
console.log(`migrations copied: ${source} -> ${destination}`);
