import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/js/memo_table.js is a classic browser script; load its pure functions into a sandbox.
const sandbox: Record<string, unknown> = {};
vm.runInNewContext(fs.readFileSync(path.join(process.cwd(), 'public/js/memo_table.js'), 'utf8'), sandbox);
const parseFirstMarkdownTable = sandbox.parseFirstMarkdownTable as (text: string) => { rows: string[][]; start: number; end: number } | null;
const serializeMarkdownTable = sandbox.serializeMarkdownTable as (rows: string[][]) => string;
const replaceOrAppendTable = sandbox.replaceOrAppendTable as (text: string, rows: string[][]) => string;
type Edit = (rows: string[][], at: number) => string[][];
const insertTableRow = sandbox.insertTableRow as Edit;
const removeTableRow = sandbox.removeTableRow as Edit;
const insertTableColumn = sandbox.insertTableColumn as Edit;
const removeTableColumn = sandbox.removeTableColumn as Edit;

describe('memo table', () => {
  it('serializes cells to a Markdown table, escaping pipes and line breaks', () => {
    expect(serializeMarkdownTable([['手法', '特徴'], ['BM25', 'AI不要|再現性'], ['LLM', '曖昧な目的\nに強い']])).toBe(
      '| 手法 | 特徴 |\n| --- | --- |\n| BM25 | AI不要\\|再現性 |\n| LLM | 曖昧な目的 に強い |',
    );
  });

  it('parses the table back (round trip) and pads short rows', () => {
    const rows = [['a', 'b'], ['1', 'x|y'], ['2', '']];
    expect(parseFirstMarkdownTable(serializeMarkdownTable(rows))?.rows).toEqual(rows);
    expect(parseFirstMarkdownTable('| a | b |\n| --- | --- |\n| 1 |')?.rows).toEqual([['a', 'b'], ['1', '']]);
  });

  it('replaces the first table in place, keeping the surrounding memo', () => {
    const memo = '前置き\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n後書き';
    const next = replaceOrAppendTable(memo, [['a', 'b'], ['1', '3']]);
    expect(next).toBe('前置き\n\n| a | b |\n| --- | --- |\n| 1 | 3 |\n\n後書き');
  });

  it('appends a table when the memo has none', () => {
    expect(replaceOrAppendTable('メモ本文', [['h'], ['v']])).toBe('メモ本文\n\n| h |\n| --- |\n| v |\n');
    expect(replaceOrAppendTable('', [['h']])).toBe('| h |\n| --- |\n');
  });

  it('ignores pipe lines that are not a table', () => {
    expect(parseFirstMarkdownTable('a | b\nc | d')).toBeNull();
  });
});

describe('memo table: row/column edits', () => {
  const rows = [['a', 'b'], ['1', '2'], ['3', '4']];

  it('inserts and removes rows at a position without touching the original', () => {
    expect(insertTableRow(rows, 2)).toEqual([['a', 'b'], ['1', '2'], ['', ''], ['3', '4']]);
    expect(removeTableRow(rows, 1)).toEqual([['a', 'b'], ['3', '4']]);
    expect(rows).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });

  it('never removes the header row or the last remaining row', () => {
    expect(removeTableRow(rows, 0)).toEqual(rows);
    expect(removeTableRow([['only']], 0)).toEqual([['only']]);
  });

  it('inserts and removes columns, keeping at least one', () => {
    expect(insertTableColumn(rows, 1)).toEqual([['a', '列1', 'b'], ['1', '', '2'], ['3', '', '4']]);
    expect(insertTableColumn([['列1', '列3'], ['', '']], 2)[0]).toEqual(['列1', '列3', '列2']);
    expect(removeTableColumn(rows, 0)).toEqual([['b'], ['2'], ['4']]);
    expect(removeTableColumn([['x'], ['y']], 0)).toEqual([['x'], ['y']]);
  });
});
