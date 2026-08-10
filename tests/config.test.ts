import { describe, expect, it } from 'vitest';
import { loadRuntimeConfig } from '../config/runtime_config.js';

describe('runtime configuration', () => {
  it('rejects PostgreSQL mode without a connection URL', () => {
    expect(() => loadRuntimeConfig({ STORAGE_DRIVER: 'postgres' })).toThrow('POSTGRES_URL is required');
  });

  it('keeps SQLite as the safe default', () => {
    expect(loadRuntimeConfig({}).STORAGE_DRIVER).toBe('sqlite');
  });

});
