export type LogFn = (...a: any[]) => void;

export function makeLogger(prefix: string) {
  const fmt = (level: string, a: any[]) => [`[${prefix}]`, level, ...a];

  return {
    log: (...a: any[]) => console.log(...fmt('', a)),
    warn: (...a: any[]) => console.warn(...fmt('WARN', a)),
    error: (...a: any[]) => console.error(...fmt('ERR', a)),
  };
}
