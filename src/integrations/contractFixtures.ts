import { buildRecordingCloudEvent } from './CloudEventBuilder';
import { INTEGRATION_EVENT_TYPE_PREFIX } from './config';
import type { IntegrationRecordingV1 } from './contracts';
import { buildIntegrationTestPayload } from './IntegrationTestEvent';
import { sha256Hex, stableJsonSerialize } from './serialization';
import { signStandardWebhook } from './webhook/StandardWebhookSigner';

export const INTEGRATION_CONTRACT_FIXTURE_VERSION = 1 as const;
export const INTEGRATION_CONTRACT_TEST_SIGNING_SECRET =
  'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

const PRODUCER_ID = 'producer_contract_fixture_v1';
const RECORDING_ID = 'recording_contract_fixture_v1';

export type IntegrationContractFixture = {
  filename: string;
  body: string;
  sha256: string;
  headers: {
    'content-type': 'application/cloudevents+json';
    'webhook-id': string;
    'webhook-timestamp': string;
    'webhook-signature': string;
  };
};

export type IntegrationContractFixtureManifest = {
  version: typeof INTEGRATION_CONTRACT_FIXTURE_VERSION;
  testSigningSecret: string;
  fixtures: Array<{
    filename: string;
    sha256: string;
    headers: IntegrationContractFixture['headers'];
  }>;
};

export async function buildIntegrationContractFixtures(): Promise<{
  fixtures: IntegrationContractFixture[];
  manifest: IntegrationContractFixtureManifest;
}> {
  const baseRecording: IntegrationRecordingV1 = {
    id: RECORDING_ID,
    title: 'CRM contract review',
    startedAt: '2026-10-07T11:15:00.000Z',
    endedAt: '2026-10-07T12:00:00.000Z',
    durationMs: 2_700_000,
    source: {
      kind: 'meeting',
      provider: 'google-meet',
      meetingId: 'abc-defg-hij',
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    },
    note: 'Confirm the CRM receiver contract before rollout.',
    notations: [
      {
        tStartMs: 75_000,
        tEndMs: 91_000,
        text: 'Review retry and idempotency semantics.',
      },
    ],
    transcript: {
      source: 'meet-captions',
      segments: [
        {
          tStartMs: 0,
          tEndMs: 4_500,
          speaker: 'Speaker 1',
          text: 'The receiver verifies the exact signed payload bytes.',
        },
      ],
    },
    analysis: {
      status: 'completed',
      topics: [
        {
          keywords: ['contract', 'webhook', 'idempotency'],
          importance: 0.93,
          spans: [{ tStartMs: 70_000, tEndMs: 100_000 }],
        },
      ],
    },
    artifacts: [
      {
        type: 'tab-recording',
        mimeType: 'video/webm',
        bytes: 1_048_576,
        delivery: 'uploaded',
        viewUrl: 'https://drive.google.com/file/d/contract-fixture-v1/view',
      },
    ],
  };

  const definitions = [
    {
      filename: 'integration-test-v1.json',
      eventId: 'event_contract_test_v1',
      eventTime: Date.parse('2026-10-07T12:00:00.000Z'),
      body: buildIntegrationTestPayload({
        eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
        eventId: 'event_contract_test_v1',
        eventTime: Date.parse('2026-10-07T12:00:00.000Z'),
        producerId: PRODUCER_ID,
      }),
    },
    {
      filename: 'recording-ready-v1.json',
      eventId: 'event_contract_ready_v1',
      eventTime: Date.parse('2026-10-07T12:01:00.000Z'),
      body: stableJsonSerialize(
        buildRecordingCloudEvent({
          eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
          eventKind: 'recording.ready.v1',
          eventId: 'event_contract_ready_v1',
          eventTime: Date.parse('2026-10-07T12:01:00.000Z'),
          producerId: PRODUCER_ID,
          externalRecordingId: RECORDING_ID,
          revision: 1,
          readiness: { complete: true, release: 'complete', pending: [] },
          recording: baseRecording,
        }),
      ),
    },
    {
      filename: 'recording-updated-v1.json',
      eventId: 'event_contract_updated_v1',
      eventTime: Date.parse('2026-10-07T12:02:00.000Z'),
      body: stableJsonSerialize(
        buildRecordingCloudEvent({
          eventTypePrefix: INTEGRATION_EVENT_TYPE_PREFIX,
          eventKind: 'recording.updated.v1',
          eventId: 'event_contract_updated_v1',
          eventTime: Date.parse('2026-10-07T12:02:00.000Z'),
          producerId: PRODUCER_ID,
          externalRecordingId: RECORDING_ID,
          revision: 2,
          readiness: { complete: true, release: 'complete', pending: [] },
          recording: {
            ...baseRecording,
            note: 'Receiver contract verified; publish the deterministic fixtures.',
            transcript: {
              source: 'meet-captions',
              segments: [
                ...baseRecording.transcript!.segments,
                {
                  tStartMs: 120_000,
                  tEndMs: 124_500,
                  speaker: 'Speaker 2',
                  text: 'The updated event carries the complete revision two snapshot.',
                },
              ],
            },
          },
        }),
      ),
    },
  ] as const;

  const fixtures = await Promise.all(
    definitions.map(async ({ filename, eventId, eventTime, body }) => {
      const webhookTimestamp = Math.floor(eventTime / 1000);
      const headers: IntegrationContractFixture['headers'] = {
        'content-type': 'application/cloudevents+json',
        'webhook-id': eventId,
        'webhook-timestamp': String(webhookTimestamp),
        'webhook-signature': await signStandardWebhook({
          secret: INTEGRATION_CONTRACT_TEST_SIGNING_SECRET,
          eventId,
          timestamp: webhookTimestamp,
          body,
        }),
      };

      return {
        filename,
        body,
        sha256: await sha256Hex(body),
        headers,
      };
    }),
  );

  return {
    fixtures,
    manifest: {
      version: INTEGRATION_CONTRACT_FIXTURE_VERSION,
      testSigningSecret: INTEGRATION_CONTRACT_TEST_SIGNING_SECRET,
      fixtures: fixtures.map(({ filename, sha256, headers }) => ({ filename, sha256, headers })),
    },
  };
}
