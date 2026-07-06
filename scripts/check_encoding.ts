import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const mojibakePatterns = [
  '\uFFFD', '\u7E3A', '\u8B41', '\u9AEB', '\u8373', '\u8737', '\u9666',
  '\u9060', '\u9695', '\u7E67', '\u7E5D', '\u00E3', '\u00C2', '\u00C3',
].map(pattern => JSON.parse('"' + pattern + '"'));
const allowedExtensions = new Set(['.md', '.html', '.css', '.js', '.ts', '.json', '.csv']);
const excludedDirs = new Set([
  '.git', 'node_modules', 'data', 'backups', 'coverage', 'dist', 'playwright-report', 'test-results', 'scripts',
]);
const includedTopLevel = new Set([
  'README.md', 'README_ja.md', 'package.json', 'docs', 'public', 'routes', 'controllers', 'services', 'utils', 'tests',
]);

function isIncluded(relativePath: string): boolean {
  const parts = relativePath.split(path.sep);
  return includedTopLevel.has(parts[0]);
}

function hasControlCharacters(text: string): boolean {
  return /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text);
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) walk(path.join(dir, entry.name), files);
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, filePath);
    if (!isIncluded(relativePath)) continue;
    if (!allowedExtensions.has(path.extname(entry.name))) continue;
    files.push(filePath);
  }
  return files;
}

const failures: Array<{ file: string; reason: string; sample?: string }> = [];
for (const file of walk(root)) {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    failures.push({ file: path.relative(root, file), reason: 'not readable as UTF-8', sample: String(error) });
    continue;
  }

  for (const pattern of mojibakePatterns) {
    const index = text.indexOf(pattern);
    if (index !== -1) {
      failures.push({
        file: path.relative(root, file),
        reason: 'mojibake-like text U+' + pattern.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0'),
        sample: text.slice(Math.max(0, index - 20), index + 20).replace(/\s+/g, ' '),
      });
    }
  }
  if (hasControlCharacters(text)) {
    failures.push({ file: path.relative(root, file), reason: 'unexpected control character' });
  }
}

if (failures.length > 0) {
  console.error('Encoding check failed:');
  for (const failure of failures) {
    console.error(JSON.stringify(failure));
  }
  process.exit(1);
}

console.log('Encoding check passed. Scanned README, docs, package metadata, public UI, routes/services/utils, and tests.');
