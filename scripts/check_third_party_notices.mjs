import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'node_modules', 'kuromoji');
const output = path.join(root, 'dist', 'THIRD_PARTY_NOTICES', 'kuromoji');
const required = {
  'LICENSE-2.0.txt': ['Apache License', 'Version 2.0'],
  'NOTICE.md': [
    'mecab-ipadic-2.7.0-20070801',
    'Copyright 2000, 2001, 2002, 2003 Nara Institute of Science',
    'must include both the above copyright notice and the following',
    'NO WARRANTY',
  ],
};

for (const [name, requiredText] of Object.entries(required)) {
  const sourcePath = path.join(source, name);
  const outputPath = path.join(output, name);
  assert.ok(fs.existsSync(sourcePath), `Kuromoji source notice missing: ${name}`);
  assert.ok(fs.existsSync(outputPath), `Built third-party notice missing: ${name}`);
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const outputText = fs.readFileSync(outputPath, 'utf8');
  assert.equal(outputText, sourceText, `Built notice differs from installed Kuromoji notice: ${name}`);
  for (const fragment of requiredText) assert.ok(outputText.includes(fragment), `${name} is missing required attribution text: ${fragment}`);
}

console.log('Kuromoji Apache-2.0 and bundled mecab-ipadic notices are present and unchanged in dist.');
