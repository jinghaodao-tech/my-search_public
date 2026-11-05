import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readJsonObjects } from '../quality/japanese-human-retrieval-datasets/miracl_json_stream.js';

describe('MIRACL JSON stream parser', () => {
  it('preserves literal newlines in a JSON string and parses the next record', async () => {
    const input = Readable.from([
      '{"docid":"one","title":"A","text":"first line\n',
      'second line with } and \\"quote\\""}\n',
      '{"docid":"two","title":"B","text":"escaped\\nnewline"}\n',
    ]);
    const rows = [];
    for await (const row of readJsonObjects<{docid:string;title:string;text:string}>(input)) rows.push(row.value);
    expect(rows).toEqual([
      {docid:'one',title:'A',text:'first line\nsecond line with } and "quote"'},
      {docid:'two',title:'B',text:'escaped\nnewline'},
    ]);
  });

  it('rejects an incomplete object instead of silently dropping it', async () => {
    const input = Readable.from(['{"docid":"broken","text":"unterminated']);
    await expect(async () => {
      for await (const _ of readJsonObjects(input)) { /* consume */ }
    }).rejects.toThrow('Truncated MIRACL JSON object');
  });
});
