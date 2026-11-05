import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app, database } from './helpers.js';
import { assessReaderTools, evaluateReaderFormula, normalizeReaderToolsPayload, prepareReaderTools, readerToolsSourceHash } from '../services/reader_tools_service.js';

const calculator = [
  '電気料金の簡易計算',
  '計算: 月額料金',
  '式: total (円) = usage * rate',
  '入力: usage | 使用量 | kWh | 0 | 1000 | 300',
  '入力: rate | 単価 | 円/kWh | 0 | 50 | 25',
];
const comparison = [
  '比較: CPU候補',
  '列: 候補|性能 (points)|消費電力 (W)',
  '行: A|80|65',
  '行: B|90|75',
];

describe('reader tools: strict local preparation and calculation', () => {
  it('distinguishes supported, unsupported and uncertain applicability without confidence scores', () => {
    expect(assessReaderTools(calculator).status).toBe('supported');
    expect(assessReaderTools(['ordinary article']).status).toBe('unsupported');
    expect(assessReaderTools(['計算: incomplete']).status).toBe('uncertain');
    expect(assessReaderTools(calculator, false).reason).toBe('disabled_by_internal_flag');
  });

  it('prepares a calculator only when formula, variables, units and ranges are explicit', () => {
    const [tool] = prepareReaderTools(calculator);
    expect(tool?.kind).toBe('calculator');
    if (tool?.kind !== 'calculator') throw new Error('calculator not prepared');
    expect(evaluateReaderFormula(tool.rpn, { usage: 300, rate: 25 })).toBe(7500);
    expect(evaluateReaderFormula(tool.rpn, { usage: 1, rate: 0 })).toBe(0);
  });

  it('honors operator precedence, parentheses and unary signs without executing code', () => {
    const source = ['計算: safe', '式: total (units) = -(usage + 2) * rate', '入力: usage|使用量|n|0|100|3', '入力: rate|倍率|n|0|10|2'];
    const [tool] = prepareReaderTools(source);
    expect(tool?.kind).toBe('calculator');
    if (tool?.kind !== 'calculator') throw new Error('calculator not prepared');
    expect(evaluateReaderFormula(tool.rpn, { usage: 3, rate: 2 })).toBe(-10);
  });

  it('applies a unary sign to a variable before the following multiplication', () => {
    const source = ['計算: safe', '式: total (units) = -usage * rate', '入力: usage|使用量|n|0|100|3', '入力: rate|倍率|n|0|10|2'];
    const [tool] = prepareReaderTools(source);
    expect(tool?.kind).toBe('calculator');
    if (tool?.kind !== 'calculator') throw new Error('calculator not prepared');
    expect(evaluateReaderFormula(tool.rpn, { usage: 3, rate: 2 })).toBe(-6);
  });

  it.each([
    ['unknown variable', ['計算: unsafe', '式: total (円) = usage * missing', '入力: usage|使用量|kWh|0|100|1']],
    ['function call', ['計算: unsafe', '式: total (円) = fetch(1)', '入力: usage|使用量|kWh|0|100|1']],
    ['missing range', ['計算: unsafe', '式: total (円) = usage * 2', '入力: usage|使用量|kWh|0|0|1']],
    ['out-of-range default', ['計算: unsafe', '式: total (円) = usage * 2', '入力: usage|使用量|kWh|0|10|11']],
  ])('rejects unsupported calculator definitions: %s', (_label, paragraphs) => {
    expect(prepareReaderTools(paragraphs)).toEqual([]);
  });

  it('refuses division by zero, malformed RPN, and non-finite results', () => {
    expect(evaluateReaderFormula([1, 0, '/'], {})).toBeNull();
    expect(evaluateReaderFormula(['missing'], {})).toBeNull();
    expect(evaluateReaderFormula([1e16], {})).toBeNull();
    expect(evaluateReaderFormula([1e12, 1e12, '*'], {})).toBeNull();
  });

  it('stops at the paragraph cap and rejects overlong expressions', () => {
    expect(prepareReaderTools(Array.from({ length: 50_001 }, () => 'ordinary text'))).toEqual([]);
    const overlong = [
      '計算: too long',
      `式: total (units) = ${'1+'.repeat(101)}1`,
      '入力: value|値|n|0|10|5',
    ];
    expect(prepareReaderTools(overlong)).toEqual([]);
  });

  it('prepares a comparison only with numeric source rows and at least two items and criteria', () => {
    const [tool] = prepareReaderTools(comparison);
    expect(tool?.kind).toBe('comparison');
    if (tool?.kind !== 'comparison') throw new Error('comparison not prepared');
    expect(tool.criteria).toHaveLength(2);
    expect(tool.options.map(option => option.label)).toEqual(['A', 'B']);
    expect(tool.options[1].cells[0].value).toBe(90);
  });

  it('rejects incomplete or nonnumeric comparisons', () => {
    expect(prepareReaderTools(['比較: incomplete', '列: 候補|価格|速度', '行: A|10|20'])).toEqual([]);
    expect(prepareReaderTools(['比較: invalid', '列: 候補|価格|速度', '行: A|不明|20', '行: B|30|40'])).toEqual([]);
    expect(prepareReaderTools(['比較: blank', '列: 候補|価格 (円)|速度 (m/s)', '行: A||20', '行: B|30|40'])).toEqual([]);
  });

  it('validates saved input state against the current source and permitted ranges', () => {
    const hash = readerToolsSourceHash(calculator);
    const [tool] = prepareReaderTools(calculator);
    if (!tool) throw new Error('calculator not prepared');
    const valid = normalizeReaderToolsPayload(calculator, { version: 1, sourceHash: hash, values: { [tool.id]: { usage: 450, rate: 30 } } });
    expect(valid?.values[tool.id]).toEqual({ usage: 450, rate: 30 });
    expect(normalizeReaderToolsPayload(calculator, { version: 1, sourceHash: 'stale', values: {} })).toBeNull();
    expect(normalizeReaderToolsPayload(calculator, { version: 1, sourceHash: hash, values: { [tool.id]: { usage: 4500, rate: 30 } } })).toBeNull();
  });
});

describe('reader tools: storage round trip', () => {
  afterEach(() => { delete process.env.READER_TOOLS_ENABLED; });

  it('stores validated state with the saved card and restores it only for the same source', async () => {
    const saved = await request(app).post('/api/reader/save').send({
      title: 'Reader tools fixture', url: 'https://example.test/reader-tools', fetchedAt: new Date().toISOString(),
      paragraphs: calculator, memo: 'existing memo remains',
    });
    expect(saved.status).toBe(201);
    const id = saved.body.card.id;
    const opened = await request(app).get(`/api/reader/cards/${id}`);
    expect(opened.body.tools.map((tool: { kind: string }) => tool.kind)).toEqual(['calculator']);
    const tool = opened.body.tools[0];
    const state = { version: 1, sourceHash: opened.body.toolsSourceHash, values: { [tool.id]: { usage: 450, rate: 30 } } };
    const updated = await request(app).put(`/api/reader/cards/${id}`).send({
      title: opened.body.title, url: opened.body.url, fetchedAt: opened.body.fetchedAt,
      paragraphs: calculator, memo: opened.body.memo, tags: [], toolState: state,
    });
    expect(updated.status).toBe(200);
    const reopened = await request(app).get(`/api/reader/cards/${id}`);
    expect(reopened.body.memo).toBe('existing memo remains');
    expect(reopened.body.toolState.values[tool.id]).toEqual({ usage: 450, rate: 30 });

    const changed = await request(app).put(`/api/reader/cards/${id}`).send({
      title: reopened.body.title, url: reopened.body.url, fetchedAt: reopened.body.fetchedAt,
      paragraphs: [...calculator, '本文に追加'], memo: reopened.body.memo, tags: [],
    });
    expect(changed.status).toBe(200);
    const changedRead = await request(app).get(`/api/reader/cards/${id}`);
    expect(changedRead.body.toolState.sourceHash).not.toBe(changedRead.body.toolsSourceHash);
    expect(changedRead.body.memo).toBe('existing memo remains');
    const storedState = database.db.prepare('SELECT payload_json FROM reader_tool_state WHERE card_id = ?').get(id) as { payload_json: string };
    expect(JSON.parse(storedState.payload_json).values[tool.id]).toEqual({ usage: 450, rate: 30 });
  });

  it('honors the internal disable flag without breaking ordinary Reader operations', async () => {
    delete process.env.READER_TOOLS_ENABLED;
    const saved = await request(app).post('/api/reader/save').send({
      title: 'Disabled tools preserve saved state', url: 'https://example.test/disabled-preserve-state',
      fetchedAt: new Date().toISOString(), paragraphs: calculator, memo: 'still saved',
    });
    expect(saved.status).toBe(201);
    const id = saved.body.card.id;
    const enabledRead = await request(app).get(`/api/reader/cards/${id}`);
    const tool = enabledRead.body.tools[0];
    const state = { version: 1, sourceHash: enabledRead.body.toolsSourceHash, values: { [tool.id]: { usage: 450, rate: 30 } } };
    const stateSave = await request(app).put(`/api/reader/cards/${id}`).send({
      title: enabledRead.body.title, url: enabledRead.body.url, fetchedAt: enabledRead.body.fetchedAt,
      paragraphs: calculator, memo: enabledRead.body.memo, tags: [], toolState: state,
    });
    expect(stateSave.status).toBe(200);
    const storedBeforeDisable = database.db.prepare('SELECT payload_json FROM reader_tool_state WHERE card_id = ?').get(id) as { payload_json: string };

    process.env.READER_TOOLS_ENABLED = 'false';
    const features = await request(app).get('/api/features');
    expect(features.body.readerTools).toBe(false);
    const prepared = await request(app).post('/api/reader/tools/prepare').send({ paragraphs: calculator });
    expect(prepared.body.tools).toEqual([]);
    const reopened = await request(app).get(`/api/reader/cards/${id}`);
    expect(reopened.body.memo).toBe('still saved');
    expect(reopened.body.tools).toEqual([]);
    const disabledMemoSave = await request(app).put(`/api/reader/cards/${id}`).send({
      title: reopened.body.title, url: reopened.body.url, fetchedAt: reopened.body.fetchedAt,
      paragraphs: calculator, memo: 'memo edited while tools are disabled', tags: [],
    });
    expect(disabledMemoSave.status).toBe(200);
    expect((await request(app).get(`/api/reader/cards/${id}`)).body.memo).toBe('memo edited while tools are disabled');
    const storedAfterDisable = database.db.prepare('SELECT payload_json FROM reader_tool_state WHERE card_id = ?').get(id) as { payload_json: string };
    expect(storedAfterDisable).toEqual(storedBeforeDisable);
    expect(JSON.parse(storedAfterDisable.payload_json).values[tool.id]).toEqual({ usage: 450, rate: 30 });
  });

  it('rolls back a new card and Reader copy when tool-state persistence fails', async () => {
    const db = database.db;
    db.exec("CREATE TRIGGER reader_tool_state_insert_failure BEFORE INSERT ON reader_tool_state BEGIN SELECT RAISE(ABORT, 'injected tool-state failure'); END");
    try {
      const saved = await request(app).post('/api/reader/save').send({
        title: 'Reader tool rollback fixture', url: 'https://example.test/reader-tool-rollback',
        fetchedAt: new Date().toISOString(), paragraphs: calculator, memo: 'must roll back',
      });
      expect(saved.status).toBe(500);
      expect(db.prepare("SELECT id FROM cards WHERE title='Reader tool rollback fixture'").get()).toBeUndefined();
      expect(db.prepare("SELECT card_id FROM reader_texts WHERE card_id IN (SELECT id FROM cards WHERE title='Reader tool rollback fixture')").get()).toBeUndefined();
    } finally { db.exec('DROP TRIGGER reader_tool_state_insert_failure'); }
  });
});
