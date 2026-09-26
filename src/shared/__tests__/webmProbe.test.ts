/**
 * Against real files (tests/fixtures/webm, made with ffmpeg: 4 s of VP8 + Opus),
 * not hand-built bytes — the reader has to agree with a real muxer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeWebmHead, probeWebmTail, webmDurationMs } from '../webmProbe';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, '../../../tests/fixtures/webm', name)));

describe('reading a WebM recording from its two ends', () => {
  it('reads codecs and the header duration of a finished file (ffprobe: 4.008 s)', () => {
    const head = probeWebmHead(fixture('with-duration.webm'));
    expect(head).toMatchObject({ kind: 'webm', codecs: ['V_VP8', 'A_OPUS'], durationMs: 4008 });
  });

  it('measures a live file with no header duration from its last timestamp', () => {
    const bytes = fixture('live-no-duration.webm');
    const head = probeWebmHead(bytes);
    expect(head.durationMs).toBeNull();
    const tail = probeWebmTail(bytes.subarray(Math.max(0, bytes.length - 4096)), head.timecodeScale);
    expect(tail).not.toBeNull();
    expect(Math.abs(tail! - 4000)).toBeLessThan(300);
    expect(webmDurationMs(head, tail)).toEqual({ durationMs: tail, cutShort: false });
  });

  it('says a file is cut short when its content ends well before its header', () => {
    const head = { kind: 'webm' as const, codecs: [], durationMs: 51_000, timecodeScale: 1_000_000 };
    expect(webmDurationMs(head, 40_000)).toEqual({ durationMs: 40_000, cutShort: true });
    expect(webmDurationMs(head, 50_500)).toEqual({ durationMs: 51_000, cutShort: false });
  });

  it('knows a notes file saved under a video’s name is not media', () => {
    const vtt = new TextEncoder().encode('WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n');
    expect(probeWebmHead(vtt).kind).toBe('text');
    expect(probeWebmHead(new Uint8Array([0, 0, 0, 0])).kind).toBe('unknown');
  });
});
