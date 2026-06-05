import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RecordingStream } from '../../../src/shared/recording';

const execFileAsync = promisify(execFile);

export type MediaStreamAnalysis = {
  codecType: string;
  codecName: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  averageFps: number | null;
  frameCount: number | null;
  bitrate: number | null;
};

export type MediaArtifactAnalysis = {
  path: string;
  recordingStream: RecordingStream | null;
  formatName: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitrate: number | null;
  streams: MediaStreamAnalysis[];
  blackDurationSeconds: number;
  freezeDurationSeconds: number;
  silenceDurationSeconds: number;
  audioRmsDb: number | null;
  audioPeakDb: number | null;
  avDurationDriftMs: number | null;
  markerDriftMs: number | null;
  optionalMetricsUnavailable: string[];
};

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRate(value: unknown): number | null {
  if (typeof value !== 'string') return numberOrNull(value);
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function sumMatches(text: string, expression: RegExp): number {
  let total = 0;
  for (const match of text.matchAll(expression)) {
    total += Number(match[1]) || 0;
  }
  return Math.round(total * 1000) / 1000;
}

function lastMatch(text: string, expression: RegExp): number | null {
  const matches = [...text.matchAll(expression)];
  return matches.length ? numberOrNull(matches[matches.length - 1][1]) : null;
}

function firstMatch(text: string, expression: RegExp): number | null {
  const match = expression.exec(text);
  return match ? numberOrNull(match[1]) : null;
}

async function runFilter(
  filePath: string,
  args: string[]
): Promise<string | null> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i',
      filePath,
      ...args,
      '-f',
      'null',
      '-',
    ], { maxBuffer: 16 * 1024 * 1024 });
    return stderr;
  } catch (error: any) {
    return typeof error?.stderr === 'string' ? error.stderr : null;
  }
}

export async function assertMediaToolsAvailable(): Promise<void> {
  await Promise.all([
    execFileAsync('ffprobe', ['-version']),
    execFileAsync('ffmpeg', ['-version']),
  ]);
}

export async function analyzeMediaArtifact(
  filePath: string,
  recordingStream: RecordingStream | null = null
): Promise<MediaArtifactAnalysis> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    filePath,
  ], { maxBuffer: 16 * 1024 * 1024 });
  const probe = JSON.parse(stdout) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = (probe.streams ?? []).map((stream): MediaStreamAnalysis => ({
    codecType: String(stream.codec_type ?? 'unknown'),
    codecName: typeof stream.codec_name === 'string' ? stream.codec_name : null,
    durationSeconds: numberOrNull(stream.duration),
    width: numberOrNull(stream.width),
    height: numberOrNull(stream.height),
    averageFps: parseRate(stream.avg_frame_rate),
    frameCount: numberOrNull(stream.nb_read_frames ?? stream.nb_frames),
    bitrate: numberOrNull(stream.bit_rate),
  }));
  const video = streams.find((stream) => stream.codecType === 'video');
  const audio = streams.find((stream) => stream.codecType === 'audio');
  const unavailable: string[] = [];

  const videoLog = video
    ? await runFilter(filePath, [
      '-map',
      '0:v:0',
      '-vf',
      'blackdetect=d=0.5:pix_th=0.10,freezedetect=n=0.003:d=1',
    ])
    : null;
  const audioLog = audio
    ? await runFilter(filePath, [
      '-map',
      '0:a:0',
      '-af',
      'silencedetect=n=-50dB:d=0.5,astats=metadata=1:reset=0',
    ])
    : null;
  const markerVideoLog = video && audio
    ? await runFilter(filePath, [
      '-map',
      '0:v:0',
      '-vf',
      'crop=64:64:iw-96:32,blackdetect=d=0.2:pix_th=0.10',
    ])
    : null;

  if (video && videoLog == null) unavailable.push('video_filters');
  if (audio && audioLog == null) unavailable.push('audio_filters');
  const videoDuration = video?.durationSeconds;
  const audioDuration = audio?.durationSeconds;
  const avDurationDriftMs = videoDuration != null && audioDuration != null
    ? Math.round(Math.abs(videoDuration - audioDuration) * 1000)
    : null;
  if (video && audio && avDurationDriftMs == null) unavailable.push('av_duration_drift');
  const visualMarkerSeconds = markerVideoLog
    ? firstMatch(markerVideoLog, /black_end:([0-9.]+)/)
    : null;
  const audioMarkerSeconds = audioLog
    ? firstMatch(audioLog, /silence_end: ([0-9.]+)/)
    : null;
  const markerDriftMs = visualMarkerSeconds != null && audioMarkerSeconds != null
    ? Math.round(Math.abs(visualMarkerSeconds - audioMarkerSeconds) * 1000)
    : null;
  if (video && audio && markerDriftMs == null) unavailable.push('marker_drift');

  return {
    path: filePath,
    recordingStream,
    formatName: typeof probe.format?.format_name === 'string'
      ? probe.format.format_name
      : null,
    durationSeconds: numberOrNull(probe.format?.duration),
    sizeBytes: numberOrNull(probe.format?.size),
    bitrate: numberOrNull(probe.format?.bit_rate),
    streams,
    blackDurationSeconds: videoLog
      ? sumMatches(videoLog, /black_duration:([0-9.]+)/g)
      : 0,
    freezeDurationSeconds: videoLog
      ? sumMatches(videoLog, /freeze_duration: ([0-9.]+)/g)
      : 0,
    silenceDurationSeconds: audioLog
      ? sumMatches(audioLog, /silence_duration: ([0-9.]+)/g)
      : 0,
    audioRmsDb: audioLog
      ? lastMatch(audioLog, /RMS level dB:\s*(-?(?:inf|[0-9.]+))/g)
      : null,
    audioPeakDb: audioLog
      ? lastMatch(audioLog, /Peak level dB:\s*(-?(?:inf|[0-9.]+))/g)
      : null,
    avDurationDriftMs,
    markerDriftMs,
    optionalMetricsUnavailable: unavailable,
  };
}
