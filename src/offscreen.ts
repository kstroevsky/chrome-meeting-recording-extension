// src/offscreen.ts

/**
 * OFFSCREEN DOCUMENT ENGINE
 * 
 * This script runs in a hidden HTML page managed by the background service worker.
 * Its primary purpose is to provide a DOM-capable environment for:
 * 1. Web Audio API (mixing multiple audio streams).
 * 2. MediaRecorder (encoding video and audio into a WebM container).
 */

// Flip this on to include your local mic in the recording mix.
// NOTE: Offscreen cannot show the initial mic permission prompt.
// You must "prime" mic permission once from a visible page (popup/options/extension tab)
// via navigator.mediaDevices.getUserMedia({ audio: true }) before this will succeed.
const WANT_MIC_MIX = true

window.addEventListener('error', (e) => {
  console.error('[offscreen] window.onerror', e?.message, e?.error)
})
window.addEventListener('unhandledrejection', (e: any) => {
  console.error('[offscreen] unhandledrejection', e?.reason || e)
})
console.log('[offscreen] script loaded')

// port plumbing for communication with background
let portRef: chrome.runtime.Port | null = null
function log(...a: any[]) { console.log('[offscreen]', ...a) }

/**
 * Establishes a persistent port connection to the background script.
 * We signal 'OFFSCREEN_READY' so the background knows it can start passing stream IDs.
 */
function connectPort(): chrome.runtime.Port {
  try { portRef?.disconnect() } catch {}
  const p: chrome.runtime.Port = chrome.runtime.connect({ name: 'offscreen' })
  p.onDisconnect.addListener(() => { log('Port disconnected'); portRef = null })
  // tell background alive
  p.postMessage({ type: 'OFFSCREEN_READY' })
  log('READY signaled via Port')
  portRef = p
  return p
}
function getPort(): chrome.runtime.Port { return portRef ?? connectPort() }
function respond(req: any, payload: any) { getPort().postMessage({ __respFor: req?.__id, payload }) }

/**
 * Updates a shared state (storage) and notifies the background/popup about 
 * the current recording status.
 */
function pushState(recording: boolean, extra?: Record<string, any>) {
  try { (chrome.storage as any)?.session?.set?.({ recording }).catch?.(() => {}) } catch {}
  getPort().postMessage({ type: 'RECORDING_STATE', recording, ...extra })
}

const sleep = (ms: number) => new Promise(res => setTimeout(res, ms))

/**
 * Heuristic to create a useful filename based on the Meet URL suffix.
 */
function inferSuffixFromActiveTabUrl(url?: string | null): string {
  try {
    if (!url) return 'google-meet'
    const u = new URL(url)
    const last = u.pathname.split('/').pop() || 'google-meet'
    return last
  } catch { return 'google-meet' }
}

/**
 * Debug utility to measure audio energy (RMS).
 * Useful for diagnosing "silent recording" issues.
 */
function attachRmsMeter(track: MediaStreamTrack, label: 'RAW' | 'FINAL') {
  try {
    const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
    const ctx = new AC()
    void ctx.resume().catch(() => {})
    const src = ctx.createMediaStreamSource(new MediaStream([track]))
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    const buf = new Uint8Array(analyser.frequencyBinCount)
    src.connect(analyser)
    const id = setInterval(() => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const x = (buf[i] - 128) / 128
        sum += x * x
      }
      const rms = Math.sqrt(sum / buf.length)
      console.log('[offscreen]', `${label} input level (rms):`, rms.toFixed(3))
    }, 1000)
    track.addEventListener('ended', () => { try { clearInterval(id) } catch {} })
  } catch (e) {
    log('meter setup failed (non-fatal)', e)
  }
}

/**
 * Attempts to capture the local microphone.
 * Requires that permission was previously granted via micsetup.html.
 */
async function maybeGetMicStream(): Promise<MediaStream | null> {
  if (!WANT_MIC_MIX) return null
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const t = mic.getAudioTracks()[0]
    log('mic stream acquired:', !!t, 'muted:', t?.muted, 'enabled:', t?.enabled)
    return mic
  } catch (e) {
    log('mic getUserMedia failed (continuing without mic):', e)
    return null
  }
}

/**
 * CORE LOGIC: Uses AudioContext to mix Tab Audio with Mic Audio.
 * Without this, you would only record what you hear, or only what you say,
 * but not both in a single file.
 */
function mixAudio(tabStream: MediaStream, micStream: MediaStream | null): MediaStream {
  const tabAudio = tabStream.getAudioTracks()[0]
  if (!micStream || !tabAudio) return tabStream

  const AC = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext
  const ctx = new AC()
  void ctx.resume().catch(() => {})
  const dst = ctx.createMediaStreamDestination()

  try {
    // Connect tab audio to the destination
    const tabSource = ctx.createMediaStreamSource(new MediaStream([tabAudio]))
    tabSource.connect(dst)
  } catch (err) {
    log('tab source connect failed for mixing; using tab audio only', err)
    return tabStream
  }

  try {
    // Connect mic audio to the destination
    const micTrack = micStream.getAudioTracks()[0]
    if (micTrack) {
      const micSource = ctx.createMediaStreamSource(new MediaStream([micTrack]))
      micSource.connect(dst)
    }
  } catch (e) {
    log('mic source connect failed; continuing with tab audio only', e)
  }

  // Construct a new MediaStream containing the original video track + the mixed audio track
  const final = new MediaStream([
    ...tabStream.getVideoTracks(),
    ...dst.stream.getAudioTracks()
  ])

  return final
}

/**
 * Constraints helper for getUserMedia when using a streamId.
 */
function makeConstraints(streamId: string, source: 'tab' | 'desktop'): MediaStreamConstraints {
  const mandatory = { chromeMediaSource: source, chromeMediaSourceId: streamId } as any
  return {
    audio: {
      mandatory,
      optional: [{ googDisableLocalEcho: false }]
    } as any,
    video: {
      mandatory: {
        ...mandatory,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    } as any
  }
}

/**
 * Capture logic. Chrome requires source='tab' for chrome.tabCapture.getMediaStreamId.
 * We fall back to 'desktop' if needed.
 */
async function captureWithStreamId(streamId: string): Promise<MediaStream> {
  try {
    log(`Attempting getUserMedia with streamId ${streamId} source= tab`)
    const s = await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, 'tab'))
    return s
  } catch (e1: any) {
    log('[gUM] failed for chromeMediaSource=tab:', e1?.name || e1, e1?.message || e1)
  }
  log(`Attempting getUserMedia with streamId ${streamId} source= desktop`)
  return await navigator.mediaDevices.getUserMedia(makeConstraints(streamId, 'desktop'))
}

let mediaRecorder: MediaRecorder | null = null
let chunks: BlobPart[] = []
let capturing = false

/**
 * Sets up the MediaRecorder lifecycle and starts the recording.
 */
async function prepareAndRecord(baseStream: MediaStream): Promise<void> {
  const a = baseStream.getAudioTracks()
  const v = baseStream.getVideoTracks()
  log('getUserMedia() tracks:', {
    audioCount: a.length,
    videoCount: v.length,
    audioMuted: a[0]?.muted,
    audioEnabled: a[0]?.enabled
  })
  a.forEach((t) => { try { t.enabled = true } catch {} })

  if (!a.length) {
    pushState(false, { warning: 'NO_TAB_AUDIO' })
  }
  if (!v.length) throw new Error('No video track in captured stream')

  // Debug: show input levels
  const rawAudio = baseStream.getAudioTracks()[0]
  if (rawAudio) attachRmsMeter(rawAudio, 'RAW')

  // Step 1: Get Mic and Mix it with Tab Audio
  const micStream = await maybeGetMicStream()
  const mixedStream = mixAudio(baseStream, micStream)

  const finalAudio = mixedStream.getAudioTracks()[0]
  if (finalAudio) attachRmsMeter(finalAudio, 'FINAL')
  if (!finalAudio) log('WARNING: final stream has NO audio track — recording will be silent')

  log('final stream tracks -> video:', mixedStream.getVideoTracks().length, 'audio:', mixedStream.getAudioTracks().length)

  chunks = []
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm'

  // Step 2: Initialize MediaRecorder
  mediaRecorder = new MediaRecorder(mixedStream, {
    mimeType: mime,
    videoBitsPerSecond: 3_000_000,
    audioBitsPerSecond: 128_000
  })

  const started = new Promise<void>((resolve, reject) => {
    const startTimeout = setTimeout(() => reject(new Error('MediaRecorder did not start (timeout)')), 4000)

    mediaRecorder!.onstart = () => {
      clearTimeout(startTimeout)
      capturing = true
      pushState(true)
      log('MediaRecorder started')
      resolve()
    }

    mediaRecorder!.onerror = (e: any) => {
      clearTimeout(startTimeout)
      log('MediaRecorder error', e)
      try { mixedStream.getTracks().forEach(t => t.stop()) } catch {}
      mediaRecorder = null
      capturing = false
      pushState(false)
      reject(new Error(e?.name || 'MediaRecorder error'))
    }

    // Collect chunks of video data as they arrive
    mediaRecorder!.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) chunks.push(e.data)
    }

    // Finalize recording: create Blob -> Object URL -> ask background to save
    mediaRecorder!.onstop = async () => {
      try {
        const blob = new Blob(chunks, { type: mime })
        log('Finalizing; chunks =', chunks.length, 'blob.size =', blob.size)

        let suffix = 'google-meet'
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
          suffix = inferSuffixFromActiveTabUrl(tabs[0]?.url || null)
        } catch {}

        const filename = `google-meet-recording-${suffix}-${Date.now()}.webm`
        const blobUrl = URL.createObjectURL(blob)
        // Background handles the downloads.download call
        getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl })
      } catch (e) {
        log('Finalize/Save failed', e)
      } finally {
        try { mixedStream.getTracks().forEach(t => t.stop()) } catch {}
        mediaRecorder = null
        chunks = []
        capturing = false
        pushState(false)
      }
    }
  })

  // Start recording in 1-second chunks
  mediaRecorder.start(1000)

  // Auto-stop if the tab is closed or navigation happens (causing track to end)
  mixedStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    log('Video track ended')
    if (mediaRecorder && capturing) { try { mediaRecorder.stop() } catch {} }
  })

  await started
}

async function startRecordingFromStreamId(streamId: string): Promise<void> {
  if (capturing) { log('Already recording; ignoring start'); return }
  const baseStream = await captureWithStreamId(streamId)
  await prepareAndRecord(baseStream)
}

function stopRecording() {
  if (!mediaRecorder || !capturing) {
    console.warn('[offscreen] Stop called but not recording')
    throw new Error('Not currently recording')
  }
  try { mediaRecorder.stop() } catch (e) { console.error('[offscreen] Stop error', e); throw e }
}

/**
 * Message routing for calls from Background.
 */
const rpcPort = getPort()
rpcPort.onMessage.addListener(async (msg: any) => {
  try {
    if (msg?.type === 'OFFSCREEN_START') {
      const streamId = msg.streamId as string | undefined
      if (!streamId) return respond(msg, { ok: false, error: 'Missing streamId' })
      try {
        await startRecordingFromStreamId(streamId)
        return respond(msg, { ok: true })
      } catch (e: any) {
        return respond(msg, { ok: false, error: `${e?.name || 'Error'}: ${e?.message || e}` })
      }
    }

    if (msg?.type === 'OFFSCREEN_STOP') {
      try { stopRecording(); return respond(msg, { ok: true }) }
      catch (e) { return respond(msg, { ok: false, error: String(e) }) }
    }

    if (msg?.type === 'OFFSCREEN_STATUS') {
      let recording = false
      try {
        const res = await (chrome.storage as any)?.session?.get?.(['recording'])
        recording = !!res?.recording
      } catch {}
      return respond(msg, { recording })
    }

    if (msg?.type === 'REVOKE_BLOB_URL' && typeof msg.blobUrl === 'string') {
      try { URL.revokeObjectURL(msg.blobUrl) } catch {}
      return
    }
  } catch (e) {
    console.error('[offscreen] error', e)
    respond(msg, { ok: false, error: String(e) })
  }
})

/**
 * Fallback listeners for when the Port isn't fully initialized yet.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  try {
    if (msg?.type === 'OFFSCREEN_PING') { sendResponse({ ok: true, via: 'onMessage' }); return true }
    if (msg?.type === 'OFFSCREEN_CONNECT') { connectPort(); sendResponse({ ok: true }); return true }
  } catch (e) { sendResponse({ ok: false, error: String(e) }) }
  return false
})
