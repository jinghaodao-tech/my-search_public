import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'docs', 'openapi.yaml');
const source = fs.readFileSync(file, 'utf8');
const required = ['openapi:', 'info:', 'paths:', '/healthz:', '/api/cards:', '/api/run:', '/api/collect:', '/api/jobs:', '/api/jobs/{id}:', 'components:'];
const missing = required.filter(marker => !source.includes(marker));
if (missing.length) {
  console.error(`OpenAPI contract is missing: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`OpenAPI contract check passed (${required.length} required sections)`);
}
