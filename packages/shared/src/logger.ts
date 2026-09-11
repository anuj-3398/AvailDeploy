type Level = 'debug' | 'info' | 'warn' | 'error';

const COLORS: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};
const RESET = '\x1b[0m';
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

export function createLogger(scope: string) {
  const emit = (level: Level, args: unknown[]) => {
    const time = new Date().toISOString().slice(11, 23);
    const tag = `${time} ${level.toUpperCase().padEnd(5)} [${scope}]`;
    const head = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
    const stream =
      level === 'error' || level === 'warn' ? console.error : console.log;
    stream(head, ...args);
  };
  return {
    debug: (...a: unknown[]) => {
      if (process.env.DEBUG) emit('debug', a);
    },
    info: (...a: unknown[]) => emit('info', a),
    warn: (...a: unknown[]) => emit('warn', a),
    error: (...a: unknown[]) => emit('error', a),
  };
}

export type Logger = ReturnType<typeof createLogger>;
