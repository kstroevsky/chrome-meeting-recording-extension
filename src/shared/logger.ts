/**
 * @file shared/logger.ts
 *
 * Tiny namespaced logger helper for consistent console prefixes.
 */

import { isTestRuntime } from './build';

export type LogFn = (...a: any[]) => void;

/**
 * Creates a prefixed logger bound to a specific extension context.
 *
 * Using a factory (rather than a global logger) means:
 *  - Each context ([background], [offscreen], [popup], etc.) labels its own
 *    output so you can filter DevTools console by prefix.
 *  - warn/error levels are distinguishable at a glance.
 *
 * Output format:
 *   console.log   → [prefix] your message
 *   console.warn  → [prefix] WARN your message
 *   console.error → [prefix] ERR  your message
 */
export function makeLogger(prefix: string) {
  return {
    log:   (...a: any[]) => {
      if (isTestRuntime()) console.log(`[${prefix}]`, ...a);
    },
    warn:  (...a: any[]) => console.warn(`[${prefix}] WARN`, ...a),
    error: (...a: any[]) => console.error(`[${prefix}] ERR`, ...a),
  };
}
