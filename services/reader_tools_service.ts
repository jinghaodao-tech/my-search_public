import { createHash } from 'node:crypto';

export type ReaderToolVariable = {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  initial: number;
  sourceIndex: number;
};

export type ReaderCalculatorTool = {
  id: string;
  kind: 'calculator';
  title: string;
  expression: string;
  resultUnit: string;
  rpn: Array<number | string>;
  variables: ReaderToolVariable[];
  sourceIndices: number[];
};

export type ReaderComparisonCell = {
  key: string;
  value: number;
  sourceIndex: number;
};

export type ReaderComparisonTool = {
  id: string;
  kind: 'comparison';
  title: string;
  criteria: Array<{ key: string; label: string; unit: string; sourceIndex: number }>;
  options: Array<{ key: string; label: string; sourceIndex: number; cells: ReaderComparisonCell[] }>;
  sourceIndices: number[];
};

export type ReaderTool = ReaderCalculatorTool | ReaderComparisonTool;

export type ReaderToolsPayload = {
  version: 1;
  sourceHash: string;
  tools: ReaderTool[];
  values: Record<string, Record<string, number>>;
};

export type ReaderToolAssessment = {
  status: 'supported' | 'unsupported' | 'uncertain';
  reason: 'strict_definition_matched' | 'no_supported_structure' | 'incomplete_or_unsafe_definition' | 'disabled_by_internal_flag';
  tools: ReaderTool[];
};

export type ReaderCalculatorProposal = {
  title: string;
  expression: string;
  resultUnit: string;
  variables: Array<{ key: string; label: string; unit: string; min: number; max: number; initial: number; quote: string }>;
  sourceQuote: string;
};

const MAX_PARAGRAPHS = 50_000;
const MAX_TOOL_BLOCK_PARAGRAPHS = 40;
const MAX_ABS_INPUT = 1e12;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const OPERATORS = new Set(['+', '-', '*', '/']);

function stableId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function parseExpression(expression: string, allowed: Set<string>): Array<number | string> | null {
  if (expression.length > 200) return null;
  const tokens = expression.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/]/g) ?? [];
  if (!tokens.length || tokens.join('') !== expression.replace(/\s+/g, '')) return null;
  const output: Array<number | string> = [];
  const operators: string[] = [];
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, 'u+': 3, 'u-': 3 };
  let expectValue = true;
  for (const token of tokens) {
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) {
      if (!expectValue) return null;
      const value = Number(token);
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT) return null;
      output.push(value);
      expectValue = false;
    } else if (IDENTIFIER.test(token)) {
      if (!expectValue || !allowed.has(token)) return null;
      output.push(token);
      expectValue = false;
    } else if (token === '(') {
      if (!expectValue) return null;
      operators.push(token);
    } else if (token === ')') {
      if (expectValue) return null;
      while (operators.length && operators.at(-1) !== '(') output.push(operators.pop()!);
      if (operators.pop() !== '(') return null;
      expectValue = false;
    } else if (OPERATORS.has(token)) {
      const unary = expectValue;
      const op = unary ? `u${token}` : token;
      if (expectValue && token !== '+' && token !== '-') return null;
      // Prefix operators apply as soon as their operand is complete. Flush them
      // before handling the next binary operator (for example, -usage * rate).
      if (!unary) while (operators.length && (operators.at(-1) === 'u+' || operators.at(-1) === 'u-')) output.push(operators.pop()!);
      while (!unary && operators.length && operators.at(-1) !== '(' && precedence[operators.at(-1)!] >= precedence[op]) output.push(operators.pop()!);
      operators.push(op);
      expectValue = true;
    } else return null;
  }
  if (expectValue) return null;
  while (operators.length) {
    const op = operators.pop()!;
    if (op === '(') return null;
    output.push(op);
  }
  return output;
}

export function evaluateReaderFormula(rpn: Array<number | string>, values: Record<string, number>): number | null {
  const stack: number[] = [];
  for (const token of rpn) {
    if (typeof token === 'number') {
      if (!Number.isFinite(token) || Math.abs(token) > MAX_ABS_INPUT) return null;
      stack.push(token); continue;
    }
    if (token in values && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      const value = values[token];
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT) return null;
      stack.push(value);
      continue;
    }
    if (token === 'u+' || token === 'u-') {
      if (stack.length < 1) return null;
      const value = stack.pop()!;
      stack.push(token === 'u-' ? -value : value);
      continue;
    }
    if (!OPERATORS.has(token) || stack.length < 2) return null;
    const right = stack.pop()!;
    const left = stack.pop()!;
    if (token === '/' && right === 0) return null;
    const result = token === '+' ? left + right : token === '-' ? left - right : token === '*' ? left * right : left / right;
    if (!Number.isFinite(result) || Math.abs(result) > 1e15) return null;
    stack.push(result);
  }
  return stack.length === 1 && Number.isFinite(stack[0]) ? stack[0] : null;
}

function parseCalculator(paragraphs: string[], start: number): ReaderCalculatorTool | null {
  const title = /^計算:\s*(.{1,100})$/.exec(paragraphs[start].trim())?.[1]?.trim();
  if (!title) return null;
  let formulaIndex = -1;
  let expression = '';
  let resultUnit = '';
  const variables: ReaderToolVariable[] = [];
  const sourceIndices = [start];
  for (let i = start + 1; i < Math.min(paragraphs.length, start + MAX_TOOL_BLOCK_PARAGRAPHS); i++) {
    const line = paragraphs[i].trim();
    if (/^(?:計算:|比較:)/.test(line)) break;
    const formula = /^式:\s*[A-Za-z_][A-Za-z0-9_]*\s*\(([^()]{1,30})\)\s*=\s*(.{1,200})$/.exec(line);
    if (formula) { if (formulaIndex !== -1) return null; formulaIndex = i; resultUnit = formula[1].trim(); expression = formula[2].trim(); sourceIndices.push(i); continue; }
    const match = /^入力:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\|\s*([^|]{1,60})\s*\|\s*([^|]{1,30})\s*\|\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\|\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*\|\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/.exec(line);
    if (!match) continue;
    const [, key, rawLabel, rawUnit, rawMin, rawMax, rawInitial] = match;
    const min = Number(rawMin), max = Number(rawMax), initial = Number(rawInitial);
    if (variables.length >= 20 || variables.some(v => v.key === key) || !rawLabel.trim() || !rawUnit.trim() || ![min, max, initial].every(Number.isFinite) || Math.abs(min) > MAX_ABS_INPUT || Math.abs(max) > MAX_ABS_INPUT || min >= max || initial < min || initial > max) return null;
    variables.push({ key, label: rawLabel.trim(), unit: rawUnit.trim(), min, max, initial, sourceIndex: i });
    sourceIndices.push(i);
  }
  if (formulaIndex < 0 || !variables.length) return null;
  const rpn = parseExpression(expression, new Set(variables.map(variable => variable.key)));
  if (!rpn) return null;
  return { id: `calc-${stableId(`${title}\n${resultUnit}\n${expression}\n${variables.map(v => `${v.key}:${v.unit}:${v.min}:${v.max}`).join('\n')}`)}`, kind: 'calculator', title, expression, resultUnit, rpn, variables, sourceIndices: [...new Set(sourceIndices)] };
}

function parseComparison(paragraphs: string[], start: number): ReaderComparisonTool | null {
  const title = /^比較:\s*(.{1,100})$/.exec(paragraphs[start].trim())?.[1]?.trim();
  if (!title) return null;
  let criteria: ReaderComparisonTool['criteria'] = [];
  const options: ReaderComparisonTool['options'] = [];
  const sourceIndices = [start];
  let headerIndex = -1;
  for (let i = start + 1; i < Math.min(paragraphs.length, start + MAX_TOOL_BLOCK_PARAGRAPHS); i++) {
    const line = paragraphs[i].trim();
    if (/^(?:計算:|比較:)/.test(line)) break;
    if (line.startsWith('列:')) {
      if (headerIndex !== -1 || options.length) return null;
      const cells = line.slice(2).split('|').map(cell => cell.trim());
      if (cells.length < 3 || cells.length > 9 || !cells[0]) return null;
      criteria = cells.slice(1).map((cell, index) => {
        const match = /^(.{1,60}?)(?:\s*\(([^()]{1,30})\))?$/.exec(cell);
        const label = (match?.[1] ?? cell).trim();
        const unit = match?.[2]?.trim() ?? '';
        return { key: `c${index}`, label, unit, sourceIndex: i };
      });
      if (criteria.length < 2 || criteria.some(item => !item.label || !item.unit)) return null;
      headerIndex = i;
      sourceIndices.push(i);
      continue;
    }
    if (line.startsWith('行:')) {
      if (headerIndex < 0) return null;
      const cells = line.slice(2).split('|').map(cell => cell.trim());
      if (cells.length !== criteria.length + 1 || cells.some(cell => !cell) || options.some(option => option.label === cells[0])) return null;
      if (options.length >= 12) return null;
      const values = cells.slice(1).map(Number);
      if (values.some(value => !Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT)) return null;
      const optionIndex = options.length;
      options.push({ key: `o${optionIndex}`, label: cells[0].slice(0, 80), sourceIndex: i, cells: values.map((value, cellIndex) => ({ key: `o${optionIndex}.c${cellIndex}`, value, sourceIndex: i })) });
      sourceIndices.push(i);
    }
  }
  if (criteria.length < 2 || options.length < 2 || options.length > 12) return null;
  return { id: `compare-${stableId(`${title}\n${JSON.stringify(criteria)}\n${JSON.stringify(options)}`)}`, kind: 'comparison', title, criteria, options, sourceIndices: [...new Set(sourceIndices)] };
}

export function readerToolsSourceHash(paragraphs: string[]): string {
  return createHash('sha256').update(JSON.stringify(paragraphs)).digest('hex');
}

export function prepareReaderTools(paragraphs: string[]): ReaderTool[] {
  if (!Array.isArray(paragraphs) || paragraphs.length > MAX_PARAGRAPHS) return [];
  const tools: ReaderTool[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (tools.length >= 20) break;
    if (/^計算:\s*/.test(paragraphs[i].trim())) {
      const tool = parseCalculator(paragraphs, i);
      if (tool) tools.push(tool);
    } else if (/^比較:\s*/.test(paragraphs[i].trim())) {
      const tool = parseComparison(paragraphs, i);
      if (tool) tools.push(tool);
    }
  }
  return tools;
}

/** Convert an untrusted model proposal into the existing arithmetic-only Reader tool shape. */
export function validateReaderCalculatorProposal(input: unknown, sourceParagraph: string, sourceIndex: number): ReaderCalculatorTool | null {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= MAX_PARAGRAPHS) return null;
  const proposal = input as Partial<ReaderCalculatorProposal>;
  const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
  const title = clean(proposal.title, 100);
  const expression = clean(proposal.expression, 200);
  const resultUnit = clean(proposal.resultUnit, 30);
  const sourceQuote = clean(proposal.sourceQuote, 3000).normalize('NFKC').replace(/\s+/g, ' ').trim();
  const paragraph = sourceParagraph.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!title || !resultUnit || !sourceQuote || !paragraph.includes(sourceQuote) || !sourceQuote.includes(resultUnit)) return null;
  if (!Array.isArray(proposal.variables) || proposal.variables.length < 1 || proposal.variables.length > 8) return null;
  const variables: ReaderToolVariable[] = [];
  for (const raw of proposal.variables) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const item = raw as Partial<ReaderCalculatorProposal['variables'][number]>;
    const key = clean(item.key, 40);
    const label = clean(item.label, 60);
    const unit = clean(item.unit, 30);
    const quote = clean(item.quote, 1000).normalize('NFKC').replace(/\s+/g, ' ').trim();
    const min = item.min, max = item.max, initial = item.initial;
    if (!IDENTIFIER.test(key) || variables.some(variable => variable.key === key) || !label || !unit || !quote || !paragraph.includes(quote) || !quote.includes(unit)) return null;
    if (![min, max, initial].every(value => typeof value === 'number' && Number.isFinite(value))) return null;
    const minValue = min as number, maxValue = max as number, initialValue = initial as number;
    if (Math.abs(minValue) > MAX_ABS_INPUT || Math.abs(maxValue) > MAX_ABS_INPUT || Math.abs(initialValue) > MAX_ABS_INPUT || minValue >= maxValue || initialValue < minValue || initialValue > maxValue) return null;
    const quoteNumbers = quote.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? [];
    if (![minValue, maxValue, initialValue].every(value => quoteNumbers.some(number => Number(number) === value))) return null;
    variables.push({ key, label, unit, min: minValue, max: maxValue, initial: initialValue, sourceIndex });
  }
  const rpn = parseExpression(expression, new Set(variables.map(variable => variable.key)));
  if (!rpn) return null;
  const sourceNumbers = sourceQuote.match(/-?(?:\d+(?:\.\d*)?|\.\d+)/g) ?? [];
  if (rpn.some(token => typeof token === 'number' && !sourceNumbers.some(number => Number(number) === token))) return null;
  const id = `ai-calc-${stableId(`${sourceIndex}\n${title}\n${expression}\n${sourceQuote}`)}`;
  return { id, kind: 'calculator', title, expression, resultUnit, rpn, variables, sourceIndices: [sourceIndex] };
}

export function assessReaderTools(paragraphs: string[], enabled = true): ReaderToolAssessment {
  if (!enabled) return { status: 'unsupported', reason: 'disabled_by_internal_flag', tools: [] };
  const tools = prepareReaderTools(paragraphs);
  if (tools.length) return { status: 'supported', reason: 'strict_definition_matched', tools };
  const declaresTool = paragraphs.some(paragraph => /^(?:計算:|比較:)/.test(paragraph.trim()));
  return declaresTool
    ? { status: 'uncertain', reason: 'incomplete_or_unsafe_definition', tools: [] }
    : { status: 'unsupported', reason: 'no_supported_structure', tools: [] };
}

export function normalizeReaderToolsPayload(paragraphs: string[], input: unknown): ReaderToolsPayload | null {
  if (!input || typeof input !== 'object') return null;
  const payload = input as Partial<ReaderToolsPayload>;
  const hash = readerToolsSourceHash(paragraphs);
  if (payload.version !== 1 || payload.sourceHash !== hash || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) return null;
  const tools = prepareReaderTools(paragraphs);
  const validToolIds = new Set(tools.map(tool => tool.id));
  const suppliedToolIds = Object.keys(payload.values);
  if (suppliedToolIds.length > tools.length || suppliedToolIds.some(id => !validToolIds.has(id))) return null;
  const values: ReaderToolsPayload['values'] = {};
  for (const tool of tools) {
    const provided = payload.values[tool.id];
    const allowed = tool.kind === 'calculator' ? tool.variables.map(variable => variable.key) : tool.options.flatMap(option => option.cells.map(cell => cell.key));
    if (provided && (typeof provided !== 'object' || Array.isArray(provided) || Object.keys(provided).length > allowed.length || Object.keys(provided).some(key => !allowed.includes(key)))) return null;
    const output: Record<string, number> = {};
    for (const key of allowed) {
      const initial = tool.kind === 'calculator' ? tool.variables.find(variable => variable.key === key)!.initial : tool.options.flatMap(option => option.cells).find(cell => cell.key === key)!.value;
      const value = provided && Object.hasOwn(provided, key) ? provided[key] : initial;
      if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_INPUT) return null;
      if (tool.kind === 'calculator') {
        const variable = tool.variables.find(item => item.key === key)!;
        if (value < variable.min || value > variable.max) return null;
      }
      output[key] = value;
    }
    values[tool.id] = output;
  }
  return { version: 1, sourceHash: hash, tools, values };
}

export function parseStoredReaderTools(raw: string | null | undefined): ReaderToolsPayload | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as ReaderToolsPayload;
    if (payload?.version !== 1 || !/^[a-f0-9]{64}$/.test(payload.sourceHash) || !Array.isArray(payload.tools) || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) return null;
    return payload;
  } catch { return null; }
}
