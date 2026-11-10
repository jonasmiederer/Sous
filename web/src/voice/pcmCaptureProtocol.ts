/**
 * Message protocol between the main thread and the `sous-pcm-capture`
 * AudioWorklet processor.
 */

export const PCM_CAPTURE_PROCESSOR_NAME = 'sous-pcm-capture';

/** Output samples (16 kHz) collected before a chunk is posted, about 128 ms. */
export const PCM_CHUNK_SAMPLES = 2048;

/** Messages the main thread sends to the processor. */
export type PcmCaptureCommand =
  /** Emit all pending samples, post `flushed`, and stop processing. */
  { type: 'flush' };

/** Messages the processor posts to the main thread. */
export type PcmCaptureEvent =
  /** 16 kHz mono Int16 LE bytes. The buffer is transferred, not copied. */
  | { type: 'chunk'; buffer: ArrayBuffer }
  /** All audio has been delivered; no more chunks follow. */
  | { type: 'flushed' };
