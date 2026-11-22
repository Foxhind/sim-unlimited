/**
 * The frame's output, decided in one place (renderer.ts):
 * - SDR: an 8-bit drawing buffer, every colour 0..1, light sources at paper white;
 * - HDR (XDR): a half-float drawing buffer, light sources written above 1.0 (renderer.ts HDR_EMISSION).
 * HDR only when all of these hold, else SDR:
 * - the player has it on (settings.hdr);
 * - the browser has the WebGL calls (drawingBufferStorage, float colour buffers);
 * - the screen shows HDR now (CSS `dynamic-range: high`; it changes with the display the window is on
 *   and with what the system allows at the moment);
 * - the page was put in extended range: WebGL drawingBufferToneMapping, or the WebGPU trigger
 *   (xdr-trigger.ts), which takes a moment and may fail.
 * Drawing HDR values on a screen that shows SDR clips every light source to white: hence the screen check.
 */
export type OutputMode = 'sdr' | 'hdr';

/** why the output is SDR: the first condition that fails, in the order above */
export type HdrBlocker = 'setting' | 'browser' | 'display' | 'pending';

export interface HdrConditions {
  wanted: boolean;
  /** the WebGL calls exist and, where the trigger is needed, it did not fail */
  browser: boolean;
  display: boolean;
  /** the page is in extended range */
  page: boolean;
}

export function hdrBlocker(c: HdrConditions): HdrBlocker | null {
  if (!c.wanted) return 'setting';
  if (!c.browser) return 'browser';
  if (!c.display) return 'display';
  if (!c.page) return 'pending';
  return null;
}

export function outputMode(c: HdrConditions): OutputMode {
  return hdrBlocker(c) === null ? 'hdr' : 'sdr';
}

/** the media query that says the screen shows HDR now; null where matchMedia is missing */
export function hdrDisplayQuery(): MediaQueryList | null {
  return typeof matchMedia === 'function' ? matchMedia('(dynamic-range: high)') : null;
}
