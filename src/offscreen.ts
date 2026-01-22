// src/offscreen.ts

/**
 * OFFSCREEN DOCUMENT ENGINE
 * 
 * This script runs in a hidden HTML page managed by the background service worker.
 * Its primary purpose is to provide a DOM-capable environment for:
 * 1. MediaRecorder (encoding video and audio into WebM containers).
 * 2. Optional mic capture for a separate audio-only recording.
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

let tabRecorder: MediaRecorder | null = null
let micRecorder: MediaRecorder | null = null
let tabChunks: BlobPart[] = []
let micChunks: BlobPart[] = []
let capturing = false
let activeRecorders = 0
let tabStreamRef: MediaStream | null = null
let micStreamRef: MediaStream | null = null
let activeSuffix = 'google-meet'
let tabRecorderStarted = false
let micRecorderStarted = false

function getVideoMime(): string {
  return MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm'
}

function getAudioMime(): string {
  return MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm'
}

function markRecorderStarted() {
  if (activeRecorders === 0) pushState(true)
  activeRecorders += 1
}

function markRecorderStopped() {
  activeRecorders = Math.max(0, activeRecorders - 1)
  if (activeRecorders === 0) {
    capturing = false
    pushState(false)
    try { tabStreamRef?.getTracks().forEach(t => t.stop()) } catch {}
    try { micStreamRef?.getTracks().forEach(t => t.stop()) } catch {}
    tabStreamRef = null
    micStreamRef = null
  }
}

function saveChunksToFile(chunksToSave: BlobPart[], mime: string, filename: string) {
  const blob = new Blob(chunksToSave, { type: mime })
  log('Finalizing', filename, 'chunks =', chunksToSave.length, 'blob.size =', blob.size)
  const blobUrl = URL.createObjectURL(blob)
  getPort().postMessage({ type: 'OFFSCREEN_SAVE', filename, blobUrl })
}

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

  if (!rawAudio) log('WARNING: tab stream has NO audio track — tab recording will be silent')

  let suffix = 'google-meet'
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    suffix = inferSuffixFromActiveTabUrl(tabs[0]?.url || null)
  } catch {}
  activeSuffix = suffix

  tabStreamRef = baseStream
  activeRecorders = 0
  tabRecorderStarted = false
  micRecorderStarted = false

  tabChunks = []
  const tabMime = getVideoMime()
  tabRecorder = new MediaRecorder(baseStream, {
    mimeType: tabMime,
    videoBitsPerSecond: 3_000_000,
    audioBitsPerSecond: 128_000
  })

  const tabStarted = new Promise<void>((resolve, reject) => {
    const startTimeout = setTimeout(() => reject(new Error('Tab MediaRecorder did not start (timeout)')), 4000)

    tabRecorder!.onstart = () => {
      clearTimeout(startTimeout)
      tabRecorderStarted = true
      capturing = true
      markRecorderStarted()
      log('Tab MediaRecorder started')
      resolve()
    }

    tabRecorder!.onerror = (e: any) => {
      clearTimeout(startTimeout)
      log('Tab MediaRecorder error', e)
      try { baseStream.getTracks().forEach(t => t.stop()) } catch {}
      if (micRecorder && micRecorder.state !== 'inactive') {
        try { micRecorder.stop() } catch {}
      }
      if (tabRecorderStarted) markRecorderStopped()
      tabRecorder = null
      tabRecorderStarted = false
      capturing = false
      pushState(false)
      reject(new Error(e?.name || 'Tab MediaRecorder error'))
    }

    tabRecorder!.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) tabChunks.push(e.data)
    }

    tabRecorder!.onstop = () => {
      try {
        const filename = `google-meet-recording-${activeSuffix}-${Date.now()}.webm`
        saveChunksToFile(tabChunks, tabMime, filename)
      } catch (e) {
        log('Tab finalize/save failed', e)
      } finally {
        tabRecorder = null
        tabRecorderStarted = false
        tabChunks = []
        markRecorderStopped()
      }
    }
  })

  tabRecorder.start(1000)

  baseStream.getVideoTracks()[0]?.addEventListener('ended', () => {
    log('Video track ended')
    if (tabRecorder && capturing) { try { tabRecorder.stop() } catch {} }
    if (micRecorder && capturing) { try { micRecorder.stop() } catch {} }
  })

  let micStarted: Promise<void> | null = null
  const micStream = await maybeGetMicStream()
  if (micStream?.getAudioTracks().length) {
    micStreamRef = micStream
    micChunks = []
    const micMime = getAudioMime()
    micRecorder = new MediaRecorder(micStream, { mimeType: micMime, audioBitsPerSecond: 128_000 })

    micStarted = new Promise<void>((resolve, reject) => {
      const startTimeout = setTimeout(() => reject(new Error('Mic MediaRecorder did not start (timeout)')), 4000)

      micRecorder!.onstart = () => {
        clearTimeout(startTimeout)
        micRecorderStarted = true
        markRecorderStarted()
        log('Mic MediaRecorder started')
        resolve()
      }

      micRecorder!.onerror = (e: any) => {
        clearTimeout(startTimeout)
        log('Mic MediaRecorder error', e)
        try { micStream.getTracks().forEach(t => t.stop()) } catch {}
        micRecorder = null
        micStreamRef = null
        if (micRecorderStarted) markRecorderStopped()
        micRecorderStarted = false
        reject(new Error(e?.name || 'Mic MediaRecorder error'))
      }

      micRecorder!.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size) micChunks.push(e.data)
      }

      micRecorder!.onstop = () => {
        try {
          const filename = `google-meet-mic-${activeSuffix}-${Date.now()}.webm`
          saveChunksToFile(micChunks, micMime, filename)
        } catch (e) {
          log('Mic finalize/save failed', e)
        } finally {
          micRecorder = null
          micRecorderStarted = false
          micChunks = []
          markRecorderStopped()
        }
      }
    })

    micRecorder.start(1000)
  } else {
    micStream?.getTracks().forEach(t => t.stop())
    micStreamRef = null
    log('Mic stream unavailable; continuing with tab-only recording')
  }

  if (micStarted) {
    micStarted.catch((e) => log('Mic recorder start failed', e))
  }
  await tabStarted
}

async function startRecordingFromStreamId(streamId: string): Promise<void> {
  if (capturing) { log('Already recording; ignoring start'); return }
  const baseStream = await captureWithStreamId(streamId)
  await prepareAndRecord(baseStream)
}

function stopRecording() {
  if (!tabRecorder || !capturing) {
    console.warn('[offscreen] Stop called but not recording')
    throw new Error('Not currently recording')
  }
  try { tabRecorder.stop() } catch (e) { console.error('[offscreen] Stop error', e); throw e }
  try { micRecorder?.stop() } catch (e) { console.error('[offscreen] Mic stop error', e) }
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
