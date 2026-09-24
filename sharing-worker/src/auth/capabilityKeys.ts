export type CapabilityKey = {
  id: string;
  secret: string;
};

export function activeCapabilityKey(env: Env): CapabilityKey {
  const id = env.CAPABILITY_KEY_ID?.trim();
  if (!id) throw new Error('Active capability key id is not configured');
  return { id, secret: capabilitySecret(env, id) };
}

export function capabilitySecret(env: Env, keyId: string): string {
  if (keyId === 'legacy') {
    if (!env.CAPABILITY_KEY?.trim()) throw new Error('Legacy capability key is not configured');
    return env.CAPABILITY_KEY;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(env.CAPABILITY_KEYS_JSON);
  } catch {
    throw new Error('Capability keyring is invalid');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Capability keyring is invalid');
  }
  const secret = (parsed as Record<string, unknown>)[keyId];
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error(`Capability key ${keyId} is unavailable`);
  }
  return secret;
}
