/** International Standard Atmosphere (troposphere + lower stratosphere). */

export const G0 = 9.80665;
export const R_AIR = 287.05287;
const T0 = 288.15;
const P0 = 101325;
const LAPSE = 0.0065;
const T_TROP = 216.65;
const H_TROP = 11000;
const P_TROP = P0 * Math.pow(T_TROP / T0, G0 / (R_AIR * LAPSE));

export interface Atmosphere {
  temperature: number;
  pressure: number;
  density: number;
  speedOfSound: number;
}

export function atmosphere(altM: number): Atmosphere {
  const h = Math.max(-500, Math.min(47000, altM));
  let temperature: number;
  let pressure: number;
  if (h <= H_TROP) {
    temperature = T0 - LAPSE * h;
    pressure = P0 * Math.pow(temperature / T0, G0 / (R_AIR * LAPSE));
  } else {
    temperature = T_TROP;
    pressure = P_TROP * Math.exp((-G0 * (h - H_TROP)) / (R_AIR * T_TROP));
  }
  const density = pressure / (R_AIR * temperature);
  return { temperature, pressure, density, speedOfSound: Math.sqrt(1.4 * R_AIR * temperature) };
}