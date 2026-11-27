export type Units = 'metric' | 'imperial';
export type Lang = 'en' | 'ru' | 'ua';
/** the on-screen stick, lever and buttons: on a touch screen by itself, always, or never */
export type TouchMode = 'auto' | 'on' | 'off';

/** a gamepad / joystick axis driving pitch, roll, yaw or the throttle (flight/gamepad.ts) */
export interface PadAxisSetting {
  i: number;
  inv: boolean;
}

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
  /** action → gamepad code ("Pad:B3", "Pad:A9-") overrides of flight/gamepad.ts DEFAULT_PAD_BINDINGS */
  padBindings: Record<string, string>;
  /** role (roll, pitch, yaw, throttle) → axis overrides; null unassigns the role's default axis */
  padAxes: Partial<Record<'roll' | 'pitch' | 'yaw' | 'throttle', PadAxisSetting | null>>;
  touchControls: TouchMode;
}

const KEY = 'sim-unlimited-settings';

export function defaultLang(): Lang {
  const l = (navigator.language || 'en').toLowerCase();
  if (l.startsWith('uk')) return 'ua';
  if (l.startsWith('ru')) return 'ru';
  return 'en';
}

export function defaultSettings(): Settings {
  return { units: 'metric', lang: defaultLang(), mouseJoystick: false, sound: true, msaa: false, hdr: true, bindings: {}, padBindings: {}, padAxes: {}, touchControls: 'auto' };
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