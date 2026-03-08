/**
 * @file shared/typeGuards.ts
 *
 * Shared low-level runtime guards used when normalizing untyped messages and
 * persisted state.
 */

/**
 * Narrows unknown values to key/value objects.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object';
}

/**
 * Safely extracts a `type` discriminator from untrusted messages.
 */
export function getMessageType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  return typeof type === 'string' ? type : null;
}

/**
 * Checks whether a message has one of the allowed type discriminators.
 */
export function hasKnownMessageType(value: unknown, allowedTypes: readonly string[]): boolean {
  const type = getMessageType(value);
  return type != null && allowedTypes.includes(type);
}
