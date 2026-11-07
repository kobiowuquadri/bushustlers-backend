// Minimal structured logger. Everything passes through `redact`, so secrets and personal data
// never reach the logs even if a caller passes a whole object by mistake.

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|cookie|signature|api[-_]?key|otp|^code$|account_?number|recipient_details|email|phone|address|^name$|full_?name|first_?name|last_?name/i;
const MAX_DEPTH = 5;

export const redact = (value: unknown, depth = 0): unknown => {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
};

type Level = 'info' | 'warn' | 'error';
const json = process.env.NODE_ENV === 'production' || process.env.LOG_FORMAT === 'json';
const silent = process.env.NODE_ENV === 'test' && process.env.LOG_IN_TESTS !== 'true';

const write = (level: Level, message: string, meta?: Record<string, unknown>) => {
  if (silent && level !== 'error') return;
  const safe = meta ? (redact(meta) as Record<string, unknown>) : undefined;
  const line = json
    ? JSON.stringify({ level, time: new Date().toISOString(), message, ...safe })
    : `[${level}] ${message}${safe && Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ''}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};

// Error details for logs: name, message and the first stack frames, never request payloads.
export const describeError = (error: unknown) => {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') };
  }
  return { errorMessage: String(error) };
};
