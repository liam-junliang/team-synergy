import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeSkillPackage, platformSkillVersion } from '@team-synergy/application';

export function bundlePlatformSkill(directory) {
  const files = [];
  function collect(relative) {
    const absolute = path.join(directory, relative);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (['.git', '__pycache__'].includes(name)) continue;
        collect(path.posix.join(relative, name));
      }
    } else if (stat.isFile()) {
      files.push({ path: relative, content_base64: readFileSync(absolute).toString('base64') });
    } else throw new Error(`Unsupported platform skill entry: ${relative}`);
  }
  collect('');
  const pack = normalizeSkillPackage(files);
  if (pack.name !== 'reverse-project-docs') throw new Error('Unexpected platform skill name');
  platformSkillVersion(pack);
  return pack;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const source = fileURLToPath(new URL('../../../skills/reverse-project-docs/', import.meta.url));
  const bundle = bundlePlatformSkill(source);
  const output = new URL('../dist/platform-skill-release.json', import.meta.url);
  mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
  writeFileSync(output, JSON.stringify(bundle));
  process.stdout.write(`Bundled ${bundle.name} ${platformSkillVersion(bundle)} (${bundle.files.length} files, ${bundle.package_sha256})\n`);
}
