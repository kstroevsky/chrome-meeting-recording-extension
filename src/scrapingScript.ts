/**
 * CONTENT SCRIPT: GOOGLE MEET CAPTION SCRAPER
 * 
 * This script is injected into Google Meet pages. It monitors the DOM for live 
 * captions and packages them into a coherent transcript.
 * 
 * Logic Overview:
 * 1. Locates the caption region via aria-labels.
 * 2. Uses MutationObserver to detect new caption blocks.
 * 3. Handles "live" updates where Google Meet replaces text as the speaker continues.
 * 4. Buffers logic ensuring we don't commit a line until the speaker has finished.
 */

let transcript: string[] = []

interface Chunk {
  startTime: number
  endTime: number
  speaker: string
  text: string
}
type OpenChunk = Chunk & { timer: number }

// Wait 2 seconds of silence before finalizing a caption block
const CHUNK_GRACE_MS = 2000

// In-memory buffer for active speakers
const prior = new Map<string, OpenChunk>()
const lastSeen = new Map<string, string>()

/**
 * Normalizes text for comparison to detect if a mutation actually changed the content.
 */
const normalize = (pre: string) =>
  pre.toLowerCase().replace(/[.,?!'"\u2019]/g, "").replace(/\s+/g, " ").trim()

/**
 * Core Logic: Processes a caption fragment.
 * Google Meet captions are fragile; they update frequently as the speech-to-text 
 * engine refines its guess. We update the 'prior' entry and reset a timer.
 */
function handleCaption(speakerKey: string, speakerName: string, rawText: string){
  const text = rawText.trim()
  if(!text) return

  const norm = normalize(text)
  const prev = lastSeen.get(speakerKey)
  if (prev === norm) return // Ignore if nothing meaningful changed
  lastSeen.set(speakerKey, norm)

  const now = Date.now()
  const existing = prior.get(speakerKey)

  if (!existing){
    // New speaker or new thought: Start a commit timer
    const timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
    prior.set(speakerKey, {
      startTime: now,
      endTime: now,
      speaker: speakerName,
      text,
      timer
    })
    return
  }

  // Update existing thought
  existing.endTime = now
  existing.text = text
  existing.speaker = speakerName

  // Reset the "grace period" timer
  clearTimeout(existing.timer)
  existing.timer = window.setTimeout(() => commit(speakerKey), CHUNK_GRACE_MS)
}

/**
 * Moves a buffered thought into the final transcript array.
 */
function commit(key: string){
  const entry = prior.get(key)
  if(!entry) return

  const startTS = new Date(entry.startTime).toISOString()
  const endTS = new Date(entry.endTime).toISOString()
  transcript.push(`[${startTS}] [${endTS}] ${entry.speaker} : ${entry.text}`.trim())
  clearTimeout(entry.timer)
  prior.delete(key)
}

/**
 * SELECTORS: Reverse-engineered classes from Google Meet.
 * WARNING: These are likely to change if Google updates their UI.
 * .ygicle -> The actual text of the caption.
 * .NWpY1d -> The speaker's name element.
 * .nMcdL  -> The parent container for a single speaker's caption block.
 */
let captionSelector = '.ygicle'
let speakerSelector = '.NWpY1d'
let captionParent  = '.nMcdL'

let captionObserver: MutationObserver | null = null

/**
 * Attaches an observer to a specific caption block to catch refinement 
 * (characterData/childList changes).
 */
function scanClasses(cl: HTMLElement){
  const txtNode = cl.querySelector<HTMLDivElement>(captionSelector)
  if(!txtNode) return

  const speakerName = cl.querySelector<HTMLElement>(speakerSelector)?.textContent?.trim() ?? ' '
  const key = cl.getAttribute('data-participant-id') || speakerName

  const push = () => {
    const trimmed = txtNode.textContent?.trim() ?? ''
    if(trimmed) handleCaption(key, speakerName, trimmed)
  }

  push()

  // Google Meet updates the text inside the div; we must observe characterData
  new MutationObserver(push).observe(txtNode, { childList: true, subtree: true, characterData: true })
}

/**
 * Attaches an observer to the parent region that contains all caption blocks.
 */
function launchAttachObserver(region: HTMLElement) {
  captionObserver?.disconnect()

  captionObserver = new MutationObserver((mutations) => {
    mutations.forEach(mutation => {
      mutation.addedNodes.forEach(node => {
        // When a new speaker block (.nMcdL) appears, start scanning it
        if (node instanceof HTMLElement && node.matches(captionParent)) {
          scanClasses(node)
        }
      })
    })
  })

  captionObserver.observe(region, { childList: true, subtree: true })
  console.log(`Caption observer attached`)
  region.querySelectorAll<HTMLElement>(captionParent).forEach(scanClasses)
}

/**
 * TOP LEVEL OBSERVER: Watches for the appearance of the "Captions" region.
 * Google Meet only mounts this region when captions are turned ON.
 */
new MutationObserver(() => {
  const region = document.querySelector<HTMLElement>('div[role="region"][aria-label="Captions"]')
  if(region){
    launchAttachObserver(region)
  }
}).observe(document.body, { childList: true, subtree: true })

// Public API for the extension (Background/Popup)
;(window as any).getTranscript = () => {
    [...prior.keys()].forEach(commit)
    return transcript.join("\n")
  }
  
  ;(window as any).resetTranscript = () => {
    prior.clear()
    transcript.length = 0
  }
  
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_TRANSCRIPT') {
      ;[...prior.keys()].forEach(commit)
      sendResponse({ transcript: transcript.join('\n') })
      return true
    }
    if (msg?.type === 'RESET_TRANSCRIPT') {
      prior.clear()
      transcript.length = 0
      sendResponse({ ok: true })
      return true
    }
  })

console.log('Transcript collector ready')
