import type { IntegrationDataPolicy, IntegrationReadiness } from './contracts';

export type IntegrationPayloadPreview = {
  body: string;
  eventId: string;
  eventType: string;
  externalRecordingId: string;
  schemaVersion: 'v1';
  revision: number;
  readiness: IntegrationReadiness;
  totalBytes: number;
  transcriptBytes: number;
  otherBytes: number;
  policy: IntegrationDataPolicy;
  syntheticIdentity: true;
};
