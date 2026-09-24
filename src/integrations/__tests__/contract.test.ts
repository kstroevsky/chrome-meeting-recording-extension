import { buildRecordingCloudEvent } from '../CloudEventBuilder';
import type { IntegrationDataPolicy } from '../contracts';
import {
  CONSERVATIVE_INTEGRATION_POLICY,
  integrationPolicyHash,
  intersectIntegrationPolicy,
  normalizeIntegrationDataPolicy,
} from '../policy';
import {
  assertIntegrationPayloadWithinLimit,
  IntegrationPayloadTooLargeError,
  measureIntegrationPayload,
} from '../payload';
import { sha256Hex, stableJsonSerialize, utf8ByteLength } from '../serialization';

describe('integration external contract', () => {
  it('makes artifact links imply artifact metadata at the shared policy boundary', () => {
    expect(normalizeIntegrationDataPolicy({
      ...CONSERVATIVE_INTEGRATION_POLICY,
      metadata: true,
      artifactMetadata: false,
      artifactLinks: true,
    })).toEqual(expect.objectContaining({
      artifactMetadata: true,
      artifactLinks: true,
    }));
  });

  it('keeps policy intersection privacy-monotonic', () => {
    const allowed: IntegrationDataPolicy = {
      metadata: true,
      meetingIdentity: true,
      userNote: true,
      notations: true,
      transcript: true,
      analysis: false,
      artifactMetadata: true,
      artifactLinks: true,
      transcriptSpeakers: 'names',
    };
    const current: IntegrationDataPolicy = {
      ...allowed,
      meetingIdentity: false,
      userNote: false,
      analysis: true,
      artifactLinks: false,
      transcriptSpeakers: 'pseudonyms',
    };

    expect(intersectIntegrationPolicy(allowed, current)).toEqual({
      metadata: true,
      meetingIdentity: false,
      userNote: false,
      notations: true,
      transcript: true,
      analysis: false,
      artifactMetadata: true,
      artifactLinks: false,
      transcriptSpeakers: 'pseudonyms',
    });
    expect(CONSERVATIVE_INTEGRATION_POLICY).toEqual(expect.objectContaining({
      metadata: false,
      transcript: false,
      analysis: false,
      transcriptSpeakers: 'omit',
    }));
  });

  it('serializes deterministically and hashes exact bytes', async () => {
    const left = stableJsonSerialize({ z: 1, a: { y: 2, b: 3 }, list: [{ q: 1, a: 2 }] });
    const right = stableJsonSerialize({ list: [{ a: 2, q: 1 }], a: { b: 3, y: 2 }, z: 1 });
    expect(left).toBe(right);
    expect(await sha256Hex(left)).toMatch(/^[a-f0-9]{64}$/);
    await expect(integrationPolicyHash({
      ...CONSERVATIVE_INTEGRATION_POLICY,
      metadata: true,
    })).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds one CloudEvent/webhook identity with an injected owned-domain prefix', () => {
    const event = buildRecordingCloudEvent({
      eventTypePrefix: 'dev.project.recorder',
      eventKind: 'recording.ready.v1',
      eventId: 'event_123',
      eventTime: Date.UTC(2026, 8, 24, 15, 15),
      producerId: 'producer_destination_a',
      externalRecordingId: 'recording_external_a',
      revision: 1,
      readiness: { complete: true, release: 'complete', pending: [] },
      recording: {
        id: 'recording_external_a',
        title: 'Example',
        startedAt: '2026-09-24T15:00:00.000Z',
        source: { kind: 'tab' },
      },
    });

    expect(event).toEqual(expect.objectContaining({
      specversion: '1.0',
      id: 'event_123',
      source: 'urn:meeting-recorder:destination:producer_destination_a',
      type: 'dev.project.recorder.recording.ready.v1',
      subject: 'recording/recording_external_a',
      time: '2026-09-24T15:15:00.000Z',
      datacontenttype: 'application/json',
    }));
    expect(() => buildRecordingCloudEvent({
      ...({
        eventTypePrefix: 'com.example.recorder',
        eventKind: 'recording.ready.v1',
        eventId: 'event_123',
        eventTime: 0,
        producerId: 'producer',
        externalRecordingId: 'recording',
        revision: 1,
        readiness: { complete: true, release: 'complete', pending: [] },
        recording: {
          id: 'recording',
          title: 'Example',
          startedAt: '1970-01-01T00:00:00.000Z',
          source: { kind: 'tab' },
        },
      } as const),
    })).toThrow('project-controlled domain');
  });

  it('measures the exact UTF-8 body and rejects oversized payloads without retry semantics', () => {
    const event = buildRecordingCloudEvent({
      eventTypePrefix: 'dev.project.recorder',
      eventKind: 'recording.updated.v1',
      eventId: 'event_123',
      eventTime: 0,
      producerId: 'producer',
      externalRecordingId: 'recording',
      revision: 2,
      readiness: { complete: true, release: 'complete', pending: [] },
      recording: {
        id: 'recording',
        title: 'Résumé',
        startedAt: '1970-01-01T00:00:00.000Z',
        source: { kind: 'tab' },
        transcript: {
          source: 'stt',
          segments: [{ tStartMs: 0, tEndMs: 10, text: 'Привет 👋' }],
        },
      },
    });

    const measured = measureIntegrationPayload(event);
    expect(measured.totalBytes).toBe(utf8ByteLength(measured.body));
    expect(measured.transcriptBytes).toBeGreaterThan(0);
    expect(measured.otherBytes + measured.transcriptBytes).toBe(measured.totalBytes);
    expect(() => assertIntegrationPayloadWithinLimit(measured, measured.totalBytes)).not.toThrow();
    expect(() => assertIntegrationPayloadWithinLimit(measured, measured.totalBytes - 1))
      .toThrow(IntegrationPayloadTooLargeError);
  });
});
