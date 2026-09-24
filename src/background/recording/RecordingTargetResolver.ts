import { getTab, sendTabMessage } from '../../platform/chrome/tabs';
import type { MeetingProviderInfo } from '../../shared/provider';
import type { RecordingSourceContext } from '../../shared/recordingContext';

export type RecordingTarget = {
  meetingSlug: string;
  source: RecordingSourceContext;
};

export async function resolveRecordingTarget(tabId: number): Promise<RecordingTarget> {
  try {
    const tab = await getTab(tabId);
    if (!tab?.url) return { meetingSlug: '', source: { kind: 'tab' } };
    const url = new URL(tab.url);
    const source = await resolveSource(tabId, tab.url);
    if (url.hostname === 'meet.google.com') {
      const code = url.pathname.split('/').filter(Boolean).pop() ?? '';
      return { meetingSlug: code ? `meet-${code}` : '', source };
    }
    const titleSlug = tab.title ? sanitizeAsSlug(tab.title) : '';
    return {
      meetingSlug: titleSlug || sanitizeAsSlug(`${url.hostname}${url.pathname}`),
      source,
    };
  } catch {
    return { meetingSlug: '', source: { kind: 'tab' } };
  }
}

async function resolveSource(tabId: number, meetingUrl: string): Promise<RecordingSourceContext> {
  try {
    const response = await sendTabMessage<{ provider?: MeetingProviderInfo }>(
      tabId,
      { type: 'GET_MEETING_PROVIDER' },
    );
    const provider = response?.provider;
    if (!provider || provider.providerId === 'unknown') return { kind: 'tab' };
    return {
      kind: 'meeting',
      provider: provider.providerId,
      ...(provider.meetingId ? { meetingId: provider.meetingId } : {}),
      meetingUrl,
    };
  } catch {
    return { kind: 'tab' };
  }
}

function sanitizeAsSlug(text: string, maxLength = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}
