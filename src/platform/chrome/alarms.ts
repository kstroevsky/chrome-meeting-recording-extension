/** Thin wrappers around Chrome alarms operations used outside entrypoints. */

export async function createAlarm(
  name: string,
  alarmInfo: chrome.alarms.AlarmCreateInfo,
): Promise<void> {
  await chrome.alarms.create(name, alarmInfo);
}

export async function getAlarm(name: string): Promise<chrome.alarms.Alarm | undefined> {
  return await chrome.alarms.get(name);
}

export async function clearAlarm(name: string): Promise<boolean> {
  return await chrome.alarms.clear(name);
}

export function addAlarmListener(
  listener: Parameters<typeof chrome.alarms.onAlarm.addListener>[0],
): void {
  chrome.alarms.onAlarm.addListener(listener);
}
