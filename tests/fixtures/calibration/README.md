# Calibration fixtures — real conversations for 4B

ADR-0007's 4B pass has only ever run against a **synthetic** corpus, which is why every semantic value in `CANDIDATE_ANALYSIS_CONFIG` is a candidate rather than a contract. Generated topic blocks have no interruptions, no callbacks, no weak transitions and no shared vocabulary between subjects — precisely the cases that decide a threshold.

This directory holds the real conversations that replace it. **Nothing here is committed**: transcripts are meeting content. `.gitignore` excludes everything except this README.

## What a conversation needs

**Timestamps and speakers, preserved.** Not optional: `longPauseMs` cannot be calibrated without real gaps, and `speakerPatternChange` cannot be calibrated without real speaker turns. A transcript stripped of either silently removes a term from the blend being tuned.

**Two kinds of label, recorded separately**, because segmentation and clustering are scored on different things:

- where a topic *changes* — the edges of the ranges below;
- which stretches are the *same* topic — a repeated `topic` id.

A call that goes Berlin → Redis → Hiring → Redis is four ranges and three ids.

## Files, per conversation

Two files with a shared basename: `<name>.vtt` (or `.json`) and `<name>.manifest.json`.

The transcript is WebVTT as most transcription tools emit it — speakers as `<v Ada>…</v>` or an `Ada:` prefix, either is read. A `.json` transcript is an array of `{ tStartMs, tEndMs, speaker?, text }` instead, if that is easier to produce.

```json
{
  "name": "weekly-sync-2026-09-04",
  "transcript": "weekly-sync-2026-09-04.vtt",
  "mergeSpeakerTurnsWithinMs": 1200,
  "holdout": false,
  "topics": [
    { "from": 0,  "to": 23, "topic": "redis-saturation" },
    { "from": 24, "to": 51, "topic": "hiring" },
    { "from": 52, "to": 78, "topic": "redis-saturation" }
  ],
  "notes": "Russian; two speakers; the Redis thread resumes after an interruption"
}
```

`from`/`to` are **utterance indices, inclusive**, into the transcript *after* merging. Every utterance must be labelled exactly once — the loader refuses gaps and overlaps rather than scoring an unlabelled turn as a wrong topic.

### `mergeSpeakerTurnsWithinMs`

A transcription tool emits fixed-length cues (often ~5 s); the pipeline's windows are **turns**. Four raw cues can be one person's twenty-second sentence rather than four turns, and calibrating window size against cue-shaped input tunes for a shape the product never sees. Setting this joins consecutive cues from one speaker separated by less than the given gap.

It is per conversation and off unless set, because the right value depends on the tool. Around a second usually recovers turns. Check the result before labelling — the indices you label are post-merge.

## The corpus

**Four conversations is a useful first pass**, on one condition: at least **three for tuning and one untouched holdout**. Thresholds picked and reported on the same calls look far more certain than the evidence warrants, and the holdout is what keeps that honest. More conversations improve confidence, but the tune/holdout split matters more than going from four to eight.

Different shapes are worth more than more of the same: clean sequential topics, frequent callbacks, interruptions, a short side topic, and two topics sharing vocabulary.

Mark the holdout with `"holdout": true` in its manifest. The grid enforces the split itself — it never tunes on that conversation, and reports it separately — rather than trusting a note to be honoured.

## Running it

```bash
npm run dev                                  # packages the Q8 encoder
EXTENSION_PATH=dist npx playwright test analysis-calibration-dump   # embeds once
npx tsx scripts/calibrate-analysis.ts        # offline grid over cached vectors
```

Embedding happens once per conversation and is cached; every grid run after that is arithmetic. That is what makes searching tens of thousands of configurations affordable.
