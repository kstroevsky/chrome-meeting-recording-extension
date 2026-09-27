import type { IntegrationDataPolicy, TranscriptSpeakerPolicy } from './contracts';
import { sha256Hex, stableJsonSerialize } from './serialization';

/** A destination starts unable to export recording state until the user opts in. */
export const CONSERVATIVE_INTEGRATION_POLICY: IntegrationDataPolicy = Object.freeze({
  metadata: false,
  meetingIdentity: false,
  userNote: false,
  notations: false,
  transcript: false,
  analysis: false,
  artifactMetadata: false,
  artifactLinks: false,
  transcriptSpeakers: 'omit',
});

const SPEAKER_PRIVACY: Record<TranscriptSpeakerPolicy, number> = {
  names: 0,
  pseudonyms: 1,
  omit: 2,
};

/**
 * Effective policy is privacy-monotonic: a recording intent can only be
 * narrowed by the destination's current policy, never silently expanded.
 */
export function intersectIntegrationPolicy(
  allowed: IntegrationDataPolicy,
  current: IntegrationDataPolicy,
): IntegrationDataPolicy {
  return canonicalizeIntegrationDataPolicy({
    metadata: allowed.metadata && current.metadata,
    meetingIdentity: allowed.meetingIdentity && current.meetingIdentity,
    userNote: allowed.userNote && current.userNote,
    notations: allowed.notations && current.notations,
    transcript: allowed.transcript && current.transcript,
    analysis: allowed.analysis && current.analysis,
    artifactMetadata: allowed.artifactMetadata && current.artifactMetadata,
    artifactLinks: allowed.artifactLinks && current.artifactLinks,
    transcriptSpeakers: morePrivateSpeakerPolicy(
      allowed.transcriptSpeakers,
      current.transcriptSpeakers,
    ),
  });
}

export async function integrationPolicyHash(policy: IntegrationDataPolicy): Promise<string> {
  return sha256Hex(stableJsonSerialize(policy));
}

export function normalizeIntegrationDataPolicy(value: unknown): IntegrationDataPolicy | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Record<string, unknown>;
  const booleanKeys = [
    'metadata',
    'meetingIdentity',
    'userNote',
    'notations',
    'transcript',
    'analysis',
    'artifactMetadata',
    'artifactLinks',
  ] as const;
  if (booleanKeys.some((key) => typeof candidate[key] !== 'boolean')) return undefined;
  if (
    candidate.transcriptSpeakers !== 'names'
    && candidate.transcriptSpeakers !== 'pseudonyms'
    && candidate.transcriptSpeakers !== 'omit'
  ) return undefined;
  return canonicalizeIntegrationDataPolicy({
    metadata: candidate.metadata as boolean,
    meetingIdentity: candidate.meetingIdentity as boolean,
    userNote: candidate.userNote as boolean,
    notations: candidate.notations as boolean,
    transcript: candidate.transcript as boolean,
    analysis: candidate.analysis as boolean,
    artifactMetadata: candidate.artifactMetadata as boolean,
    artifactLinks: candidate.artifactLinks as boolean,
    transcriptSpeakers: candidate.transcriptSpeakers,
  });
}

/** Relationships between policy fields live here so every ingress gets them. */
export function canonicalizeIntegrationDataPolicy(
  policy: IntegrationDataPolicy,
): IntegrationDataPolicy {
  return {
    ...policy,
    artifactMetadata: policy.artifactMetadata || policy.artifactLinks,
  };
}

function morePrivateSpeakerPolicy(
  left: TranscriptSpeakerPolicy,
  right: TranscriptSpeakerPolicy,
): TranscriptSpeakerPolicy {
  return SPEAKER_PRIVACY[left] >= SPEAKER_PRIVACY[right] ? left : right;
}
