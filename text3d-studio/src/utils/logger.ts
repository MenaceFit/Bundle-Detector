/**
 * Local, in-memory logger. Development builds mirror to the console; production
 * keeps a rolling buffer that can be dumped from the About panel when something
 * goes wrong. Nothing ever leaves the machine.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  scope: string;
  message: string;
  time: number;
  detail?: unknown;
}

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];
const isDev = import.meta.env?.DEV ?? false;

function push(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const entry: LogEntry = { level, scope, message, time: Date.now(), detail };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  if (isDev || level === 'error') {
    const label = `[${scope}] ${message}`;
    if (level === 'error') console.error(label, detail ?? '');
    else if (level === 'warn') console.warn(label, detail ?? '');
    else console.log(label, detail ?? '');
  }
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, detail?: unknown) => push('debug', scope, message, detail),
    info: (message: string, detail?: unknown) => push('info', scope, message, detail),
    warn: (message: string, detail?: unknown) => push('warn', scope, message, detail),
    error: (message: string, detail?: unknown) => push('error', scope, message, detail),
  };
}

export function getLogEntries(): readonly LogEntry[] {
  return entries;
}

export function dumpLogs(): string {
  return entries
    .map((e) => `${new Date(e.time).toISOString()} ${e.level.toUpperCase()} [${e.scope}] ${e.message}`)
    .join('\n');
}
