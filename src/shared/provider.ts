/**
 * @file shared/provider.ts
 *
 * Shared meeting-provider metadata returned by content-script adapters.
 */

export type MeetingProviderId = 'google-meet' | 'unknown';

export type MeetingProviderInfo = {
  providerId: MeetingProviderId;
  meetingId: string | null;
  supportsCaptions: boolean;
};
