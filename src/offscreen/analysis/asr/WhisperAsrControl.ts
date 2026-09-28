import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { PcmChunk } from '../audio/BoundedPcmSink';
import { StreamingSincResampler } from './StreamingSincResampler';
import {
  WhisperWindowAssembler,
  mapWhisperWordsToMediaTime,
  mergeWhisperOverlap,
  type WhisperAudioWindow,
  type WhisperRelativeWord,
  type WhisperTimedWord,
  type WhisperWindowConfig,
} from './WhisperWindowing';

export type WhisperDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'uint8' | 'q4' | 'bnb4';
export type WhisperDevice = 'webgpu' | 'wasm';

export type LocalWhisperConfig = {
  modelBaseUrl: string;
  wasmBaseUrl: string;
  modelId: string;
  revision: string;
  device: WhisperDevice;
  encoderDtype: WhisperDtype;
  decoderDtype: WhisperDtype;
};

export const WHISPER_SMALL_RESEARCH_MODEL = {
  id: 'onnx-community/whisper-small',
  revision: '36050c46d777d46dc4b5f43f6d90574fc38f8732',
  upstream: 'openai/whisper-small',
  upstreamLicense: 'MIT',
} as const;

export type WhisperTranscription = {
  text: string;
  words: WhisperRelativeWord[];
};

export type WhisperWindowTranscriber = {
  transcribe(window: WhisperAudioWindow, language?: string): Promise<WhisperTranscription>;
  dispose?(): Promise<void> | void;
};

export type WhisperControlConfig = WhisperWindowConfig & {
  language?: string;
  sameTimeToleranceMs: number;
  resamplerKernelLobes?: number;
};

export type WhisperControlResult = {
  words: WhisperTimedWord[];
  text: string;
  windows: number;
};

/**
 * Bounded one-window-at-a-time ASR control. PCM never accumulates beyond the
 * resampler context plus one <=30 s window and its configured overlap.
 */
export class WhisperAsrControl {
  private readonly resampler: StreamingSincResampler;
  private readonly windows: WhisperWindowAssembler;
  private words: WhisperTimedWord[] = [];
  private windowCount = 0;

  constructor(
    private readonly transcriber: WhisperWindowTranscriber,
    private readonly config: WhisperControlConfig,
  ) {
    this.resampler = new StreamingSincResampler(16_000, config.resamplerKernelLobes ?? 8);
    this.windows = new WhisperWindowAssembler(config);
  }

  /** Await this from the PCM consumer so ASR itself provides backpressure. */
  async consume(chunk: PcmChunk): Promise<void> {
    for (const block of this.resampler.push(chunk)) {
      await this.consumeWindows(this.windows.push(block));
    }
  }

  async finish(): Promise<WhisperControlResult> {
    for (const block of this.resampler.finish()) {
      await this.consumeWindows(this.windows.push(block));
    }
    await this.consumeWindows(this.windows.finish());
    return this.result();
  }

  result(): WhisperControlResult {
    return {
      words: [...this.words],
      text: this.words.map((word) => word.text).join('').trim(),
      windows: this.windowCount,
    };
  }

  async dispose(): Promise<void> {
    await this.transcriber.dispose?.();
  }

  private async consumeWindows(windows: WhisperAudioWindow[]): Promise<void> {
    for (const window of windows) {
      const output = await this.transcriber.transcribe(window, this.config.language);
      this.windowCount += 1;
      this.words = mergeWhisperOverlap(
        this.words,
        mapWhisperWordsToMediaTime(window, output.words),
        this.config.sameTimeToleranceMs,
      );
    }
  }
}

/**
 * Loads only extension-owned Whisper artifacts. The encoder and merged decoder
 * dtypes are independent experiment inputs, matching Transformers.js' per-file
 * dtype map instead of assuming E5's Q8 choice transfers to ASR.
 */
export async function createLocalWhisperTranscriber(
  config: LocalWhisperConfig,
): Promise<WhisperWindowTranscriber> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = config.modelBaseUrl;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = config.wasmBaseUrl;
    env.backends.onnx.wasm.numThreads = 1;
  }

  const asr = await pipeline('automatic-speech-recognition', config.modelId, {
    revision: config.revision,
    device: config.device,
    dtype: {
      model: config.encoderDtype,
      decoder_model_merged: config.decoderDtype,
    },
  }) as AutomaticSpeechRecognitionPipeline;

  let busy = false;
  return {
    async transcribe(window, language) {
      if (busy) throw new Error('Whisper control allows only one active audio window');
      if (window.sampleRate !== 16_000 || window.samples.length > 30 * 16_000) {
        throw new Error('Whisper control accepts only bounded mono 16 kHz windows');
      }
      busy = true;
      try {
        const output = await asr(window.samples, {
          return_timestamps: 'word',
          task: 'transcribe',
          ...(language ? { language } : {}),
          // Windowing and overlap are owned above so this call cannot create an
          // unbounded second chunk list internally.
          chunk_length_s: 0,
        });
        return {
          text: output.text,
          words: (output.chunks ?? []).map((chunk) => ({
            text: chunk.text,
            timestamp: chunk.timestamp,
          })),
        };
      } finally {
        busy = false;
      }
    },
    dispose: async () => { await asr.dispose?.(); },
  };
}
