import pino from 'pino';

export const testLogRecords: unknown[] = [];

const isTest = process.env.NODE_ENV === 'test';

const logStream = {
  write(line: string) {
    if (isTest) {
      try {
        testLogRecords.push(JSON.parse(line));
      } catch {
        testLogRecords.push(line);
      }
      return;
    }
    process.stdout.write(line);
  },
};

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      '*.authorization',
      '*.cookie',
      '*.apiKey',
      '*.api_key',
      '*.token',
      '*.password',
      '*.ANTHROPIC_API_KEY',
      '*.GEMINI_API_KEY',
    ],
    censor: '[REDACTED]',
  },
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
}, logStream);

export function clearTestLogRecords() {
  testLogRecords.length = 0;
}

export function errorMeta(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: 'NonError',
    message: String(error),
  };
}
