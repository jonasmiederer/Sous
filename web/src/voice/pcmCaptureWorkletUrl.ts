/**
 * URL of the bundled `sous-pcm-capture` AudioWorklet module.
 *
 * Import choice: Vite's `?worker&url` suffix. It bundles the worklet and its
 * imports (`pcmEncoder`, `pcmCaptureProtocol`) into one self-contained script
 * under `dist/assets/` and returns its same-origin URL, which satisfies
 * `script-src 'self'` and works with `audioWorklet.addModule(url)`.
 * Alternatives rejected:
 * - `new URL('./pcm-capture.worklet.ts', import.meta.url)` copies the raw
 *   `.ts` file as an asset without compiling it.
 * - `?url` also emits the uncompiled source.
 * - `?worker` returns a Worker constructor; a worklet is not a Worker.
 */
import pcmCaptureWorkletUrl from './pcm-capture.worklet.ts?worker&url';

export { pcmCaptureWorkletUrl };

/** Loads the processor into `context` so `new AudioWorkletNode(context, PCM_CAPTURE_PROCESSOR_NAME)` works. */
export function loadPcmCaptureWorklet(context: BaseAudioContext): Promise<void> {
  return context.audioWorklet.addModule(pcmCaptureWorkletUrl);
}
