const FALLBACK_EVENT_TYPE_PREFIX = 'dev.workers.kstroevsky.meeting-recorder';

export function integrationEventTypePrefix(): string {
  const configured = typeof __INTEGRATION_EVENT_TYPE_PREFIX__ === 'string'
    ? __INTEGRATION_EVENT_TYPE_PREFIX__.trim()
    : '';
  return configured || FALLBACK_EVENT_TYPE_PREFIX;
}
