/** Thin wrappers around Chrome alarms operations used outside entrypoints. */

export async function createAlarm(
  name: string,
  alarmInfo: chrome.alarms.AlarmCreateInfo,
): Promise<void> {
  await chrome.alarms.create(name, alarmInfo);
}

export function addAlarmListener(
  listener: Parameters<typeof chrome.alarms.onAlarm.addListener>[0],
): void {
  chrome.alarms.onAlarm.addListener(listener);
}
