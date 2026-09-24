import type { ArtifactDeliveryStatus } from '../shared/recordingHistory';
import type { TranscriptSource } from '../shared/transcript';

export type TranscriptSpeakerPolicy = 'names' | 'pseudonyms' | 'omit';

export type IntegrationDataPolicy = {
  metadata: boolean;
  meetingIdentity: boolean;
  userNote: boolean;
  notations: boolean;
  transcript: boolean;
  analysis: boolean;
  artifactMetadata: boolean;
  artifactLinks: boolean;
  transcriptSpeakers: TranscriptSpeakerPolicy;
};

export type IntegrationRecordingV1 = {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  source: {
    kind: 'meeting' | 'tab';
    provider?: string;
    meetingId?: string;
    meetingUrl?: string;
  };
  note?: string;
  notations?: Array<{
    tStartMs: number;
    tEndMs?: number;
    text: string;
  }>;
  transcript?: {
    source: TranscriptSource;
    segments: Array<{
      tStartMs: number;
      tEndMs: number;
      speaker?: string;
      text: string;
    }>;
  };
  analysis?: {
    status: 'analyzing' | 'completed' | 'failed' | 'canceled' | 'unsupported';
    error?: string;
    topics?: Array<{
      keywords: string[];
      importance: number;
      spans: Array<{
        tStartMs: number;
        tEndMs: number;
      }>;
    }>;
  };
  artifacts?: Array<{
    type:
      | 'tab-recording'
      | 'microphone-recording'
      | 'self-video'
      | 'notes'
      | 'transcript';
    mimeType: string;
    bytes?: number;
    delivery: ArtifactDeliveryStatus;
    viewUrl?: string;
  }>;
};

export type IntegrationReadinessPending =
  | 'transcript'
  | 'analysis'
  | 'artifact-delivery';

export type IntegrationReadiness = {
  complete: boolean;
  release: 'complete' | 'timeout' | 'manual';
  pending: IntegrationReadinessPending[];
};

export type IntegrationEventKind =
  | 'recording.ready.v1'
  | 'recording.updated.v1'
  | 'recording.deleted.v1'
  | 'integration.test.v1';

export type StructuredCloudEvent<T> = {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: T;
};

export type RecordingSnapshotEventData = {
  revision: number;
  readiness: IntegrationReadiness;
  recording: IntegrationRecordingV1;
};
