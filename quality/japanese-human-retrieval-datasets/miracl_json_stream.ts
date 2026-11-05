import readline from 'node:readline';
import type { Readable } from 'node:stream';

function escapeRawNewlinesInJsonStrings(json: string): string {
  let output = '';
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (inString && (char === '\n' || char === '\r')) {
      output += char === '\n' ? '\\n' : '\\r';
      continue;
    }
    output += char;
    if (!inString) {
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) escaped = false;
    else if (char === '\\') escaped = true;
    else if (char === '"') inString = false;
  }
  return output;
}

/** MIRACL shards contain occasional literal line breaks inside JSON string values. */
export async function* readJsonObjects<T>(input: Readable): AsyncGenerator<{raw: string; value: T}> {
  const lines = readline.createInterface({input, crlfDelay: Infinity});
  let raw = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  try {
    for await (const line of lines) {
      for (const char of `${line}\n`) {
        if (!raw && /\s/.test(char)) continue;
        raw += char;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        if (depth < 0) throw new Error('Unexpected closing brace in MIRACL JSON stream');
        if (depth === 0 && raw.trim()) {
          const clean = escapeRawNewlinesInJsonStrings(raw.trim());
          yield {raw, value: JSON.parse(clean) as T};
          raw = '';
          escaped = false;
        }
      }
    }
  } finally {
    lines.close();
  }
  if (raw.trim() || depth !== 0 || inString) throw new Error('Truncated MIRACL JSON object at end of shard');
}
