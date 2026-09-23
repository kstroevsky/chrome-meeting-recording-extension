import type { PerfDebugSnapshot, PerfEventEntry, PerfMediaProfile } from '../../../../shared/perf';
import { createEmptyDistribution } from '../PerfDebugState';
import {
  applyDistribution,
  matchingDurationSamples,
  toBoolean,
  toNumber,
  toRecordingStream,
} from './distribution';

function readProfile(entry: PerfEventEntry, prefix: 'requested' | ''): PerfMediaProfile {
  const field = (name: string) => prefix ? `${prefix}${name}` : name[0].toLowerCase() + name.slice(1);
  return {
    width: toNumber(entry.fields[field('Width')]),
    height: toNumber(entry.fields[field('Height')]),
    frameRate: toNumber(entry.fields[field('FrameRate')]),
  };
}

export function applyCapture(snapshot: Readonly<PerfDebugSnapshot>, entry: PerfEventEntry): void {
  const stream = toRecordingStream(entry.fields.stream);
  if (!stream) return;
  const capture = snapshot.summary.capture;
  capture.attemptCountByStream[stream] = (capture.attemptCountByStream[stream] ?? 0) + 1;
  const durationMs = toNumber(entry.fields.durationMs);
  if (entry.event === 'stream_acquired') {
    capture.successCountByStream[stream] = (capture.successCountByStream[stream] ?? 0) + 1;
    capture.lastRequestedProfileByStream[stream] = readProfile(entry, 'requested');
    capture.lastDeliveredProfileByStream[stream] = readProfile(entry, '');
    if (stream === 'mic') {
      capture.lastMicConstraints = {
        requestedEchoCancellation: toBoolean(entry.fields.requestedEchoCancellation),
        requestedNoiseSuppression: toBoolean(entry.fields.requestedNoiseSuppression),
        requestedAutoGainControl: toBoolean(entry.fields.requestedAutoGainControl),
        echoCancellation: toBoolean(entry.fields.echoCancellation),
        noiseSuppression: toBoolean(entry.fields.noiseSuppression),
        autoGainControl: toBoolean(entry.fields.autoGainControl),
      };
    }
  } else {
    capture.failureCountByStream[stream] = (capture.failureCountByStream[stream] ?? 0) + 1;
  }
  if (durationMs == null) return;
  capture.lastDurationMsByStream[stream] = durationMs;
  const distribution = capture.durationMsByStream[stream] ?? createEmptyDistribution();
  applyDistribution(
    distribution,
    durationMs,
    matchingDurationSamples(snapshot, 'capture', entry.event, stream)
  );
  capture.durationMsByStream[stream] = distribution;
}
