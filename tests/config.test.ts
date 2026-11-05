import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../config/runtime_config.js';

describe('runtime configuration', () => {
  it('rejects PostgreSQL mode without a connection URL', () => {
    expect(() => loadRuntimeConfig({ STORAGE_DRIVER: 'postgres' })).toThrow('POSTGRES_URL is required');
  });

  it('keeps SQLite as the safe default', () => {
    expect(loadRuntimeConfig({}).STORAGE_DRIVER).toBe('sqlite');
  });

  it('keeps local research experiment surfaces disabled unless explicitly enabled', () => {
    expect(loadRuntimeConfig({}).RESEARCH_EXPERIMENTS_ENABLED).toBe(false);
    expect(loadRuntimeConfig({ RESEARCH_EXPERIMENTS_ENABLED: 'true' }).RESEARCH_EXPERIMENTS_ENABLED).toBe(true);
    expect(() => loadRuntimeConfig({ RESEARCH_EXPERIMENTS_ENABLED: 'yes' })).toThrow();
    expect(loadRuntimeConfig({}).RESEARCH_EXPERIMENT_RETENTION_DAYS).toBe(30);
    expect(() => loadRuntimeConfig({ RESEARCH_EXPERIMENT_RETENTION_DAYS: '0' })).toThrow();
  });

  it('accepts the opt-in raw-text FTS5 saved-card search mode', () => {
    expect(loadRuntimeConfig({ CARD_SEARCH_ENGINE: 'fts5-raw' }).CARD_SEARCH_ENGINE).toBe('fts5-raw');
  });

  it('accepts the opt-in morphology-only FTS5 saved-card search mode', () => {
    expect(loadRuntimeConfig({ CARD_SEARCH_ENGINE: 'fts5-morph' }).CARD_SEARCH_ENGINE).toBe('fts5-morph');
  });

  it('accepts E5 RRF only as an explicit saved-card search mode', () => {
    expect(loadRuntimeConfig({ CARD_SEARCH_ENGINE: 'e5-rrf' }).CARD_SEARCH_ENGINE).toBe('e5-rrf');
    expect(loadRuntimeConfig({}).CARD_SEARCH_ENGINE).toBe('fts5-morph');
  });

  it('bounds the BM25 candidate depth used by optional E5 reranking', () => {
    expect(loadRuntimeConfig({}).CARD_SEARCH_E5_CANDIDATES).toBe(100);
    expect(() => loadRuntimeConfig({ CARD_SEARCH_E5_CANDIDATES: '501' })).toThrow();
  });

});
