export type Units = 'metric' | 'imperial';
export type Lang = 'en' | 'ru' | 'ua';

export interface Settings {
  units: Units;
  lang: Lang;
  mouseJoystick: boolean;
  sound: boolean;
  /** Q12: MSAA off by default — jaggies are part of the style */
  msaa: boolean;
  /** experimental XDR: light sources brighter than white on an HDR display (renderer.ts setHdr) */
  hdr: boolean;
  /** action → KeyboardEvent.code overrides (Q37 remapping) */
  bindings: Record<string, string>;
}

const KEY = 'sim-unlimited-settings';

export function defaultLang(): Lang {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('uk')) return 'ua';
  if (l.startsWith('ru')) return 'ru';
  return 'en';
}

export function defaultSettings(): Settings {
  return { units: 'metric', lang: defaultLang(), mouseJoystick: false, sound: true, msaa: false, hdr: true, bindings: {} };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // private mode: settings stay session-only
  }
}