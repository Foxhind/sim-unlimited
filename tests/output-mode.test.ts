import { describe, expect, it } from 'vitest';
import { hdrBlocker, outputMode, type HdrConditions } from '../src/engine/output-mode';

const all: HdrConditions = { wanted: true, browser: true, display: true, page: true };

describe('SDR or HDR output', () => {
  it('HDR only when it is on, the browser can, the screen shows HDR and the page is in extended range', () => {
    expect(outputMode(all)).toBe('hdr');
    expect(hdrBlocker(all)).toBeNull();
    for (const k of ['wanted', 'browser', 'display', 'page'] as const) {
      expect(outputMode({ ...all, [k]: false })).toBe('sdr');
    }
  });

  it('a browser with the calls on a screen without HDR draws SDR: no lights clipped to white', () => {
    expect(hdrBlocker({ ...all, display: false })).toBe('display');
  });

  it('names the first condition that fails, the setting first', () => {
    expect(hdrBlocker({ wanted: false, browser: false, display: false, page: false })).toBe('setting');
    expect(hdrBlocker({ ...all, browser: false, display: false })).toBe('browser');
    expect(hdrBlocker({ ...all, page: false })).toBe('pending');
  });
});
