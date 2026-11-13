import { RAMP } from '../engine/palette';

/** [x, y] rows — linear interpolation, clamped outside. */
export type AeroTable = [number, number][];

type V3 = [number, number, number];

/** Airframe parts that can separate. Everything else is the fuselage, which never does. */
export type PartId = 'wingL' | 'wingR' | 'stabL' | 'stabR' | 'finL' | 'finR';
export const PART_IDS: PartId[] = ['wingL', 'wingR', 'stabL', 'stabR', 'finL', 'finR'];

/**
 * One lifting surface of the strip model. The flight model takes the air velocity at `pos`
 * (including the aircraft's rotation), so each surface has its own angle of attack: roll and yaw
 * damping, wing drop at the stall, autorotation and the effect of a missing wing all follow from
 * these few rows rather than from stability derivatives.
 *
 * Body axes, metres from the centre of gravity: x right, y up, z aft. Angles in degrees.
 */
export interface SurfaceDef {
  /** separates with this part; fuselage when absent */
  part?: PartId;
  /** aerodynamic centre */
  pos: V3;
  /** unit direction of positive lift: up for wings and tailplanes, sideways for fins */
  normal: V3;
  area: number;
  /** lift-curve slope per radian while the flow is attached */
  cla: number;
  /** built-in incidence + camber: lift at zero angle of attack */
  alpha0?: number;
  /** angle of attack where the flow separates (half attached, half flat plate) */
  stall: number;
  /** induced drag factor: CDi = k * CL^2 */
  k: number;
  /** control travel at full pitch / roll / yaw command; the sign follows from the geometry */
  pitch?: number;
  roll?: number;
  yaw?: number;
  /** control effectiveness: 1 = the whole surface moves, less = a hinged flap */
  tau?: number;
  /** carries the landing flaps */
  flap?: boolean;
  /** share of dynamic pressure lost in the wing wake at high angle of attack (top-mounted fins) */
  shield?: number;
}

export interface PartDef {
  id: PartId;
  /** outermost point, probed against terrain and buildings */
  tip: V3;
  /** aerodynamic load on the part's surfaces that breaks it off, N */
  maxLoad: number;
}

/** Fly-by-wire limits: what the stick asks for, as opposed to what the surfaces can do. */
export interface FbwDef {
  /** load factor commanded at full aft / full forward stick */
  gMax: number;
  gMin: number;
  /** angle of attack the limiter holds, deg */
  alphaLimit: number;
  /** angle of attack reachable by pulling through the limiter (stick beyond 85%); equal to alphaLimit when it cannot be overridden */
  alphaOverride: number;
  /** roll rate at full stick, rad/s */
  rollRate: number;
}

export interface AircraftConfig {
  id: 'su27' | 'f117';
  name: string;
  hudLang: 'ru' | 'en';
  mass: number;
  /** pitch (x), yaw (y), roll (z) inertias, kg·m² — body axes: x right, y up, z aft */
  inertia: [number, number, number];
  /** reference wing area and span */
  wingArea: number;
  wingSpan: number;
  /** where the centre of gravity sits in the mesh's coordinates */
  cg: V3;
  surfaces: SurfaceDef[];
  parts: PartDef[];
  /** fuselage ends (from the CG), for collisions */
  nose: V3;
  tail: V3;
  /** fuselage side area, m²: cross-flow drag, the main yaw damping in a spin */
  bodySide: number;
  fbw: FbwDef;
  /** zero-lift drag of the whole airframe, and its multiplier against Mach number */
  cd0: number;
  waveDrag: AeroTable;
  /** wing induced drag factor (also in each wing surface row) */
  inducedK: number;
  /**
   * Yawing-moment coefficient of the forebody vortices that keep a flat spin turning once the nose is
   * above ~50 deg angle of attack. 0 = the airframe has no stable flat spin.
   */
  spinYaw: number;
  /** never-exceed equivalent airspeed, m/s: beyond ~110% the tail surfaces flutter off */
  vne: number;
  thrustDry: number;
  thrustAfterburner: number;
  /** m/s at altitude, used for Q41 air start (70% of cruise) */
  cruiseSpeed: number;
  maxSpeed: number;
  gearHeight: number;
  /** max touchdown sink rate m/s and bank deg before crash */
  landingSinkLimit: number;
  landingBankLimit: number;
  flapClBonus: number;
  flapCd: number;
  gearCd: number;
  speedbrakeCd: number;
  brakeDecel: number;
  /** angle of attack of the stall warning, deg */
  stallAlpha: number;
  /** exhaust exits in mesh space (x right, y up, z aft) with radius */
  nozzles: { pos: [number, number, number]; r: number }[];
}

const UP: V3 = [0, 1, 0];
const SIDE: V3 = [1, 0, 0];

/** the same surface on the right and, mirrored, on the left (for surfaces whose normal is plain up or sideways) */
function pair(def: Omit<SurfaceDef, 'part'>, right: PartId, left: PartId): SurfaceDef[] {
  return [
    { ...def, part: right },
    { ...def, part: left, pos: [-def.pos[0], def.pos[1], def.pos[2]] },
  ];
}

export const SU27: AircraftConfig = {
  id: 'su27',
  name: 'SU-27 FLANKER',
  hudLang: 'ru',
  mass: 18000,
  inertia: [280000, 320000, 55000],
  wingArea: 62,
  wingSpan: 14.7,
  cg: [0, 0, 3.4],
  surfaces: [
    // lifting body + leading-edge extensions: low aspect ratio, vortex lift that holds on to 30+ deg
    { pos: [0, 0, -1.9], normal: UP, area: 20, cla: 3.0, alpha0: 2.9, stall: 30, k: 0.115 },
    // wing panels: the swept outer part stalls first and sits aft, hence the pitch-up and wing drop
    ...pair({ pos: [2.8, 0, -0.5], normal: UP, area: 9, cla: 4.8, alpha0: 2.9, stall: 22, k: 0.115, flap: true }, 'wingR', 'wingL'),
    ...pair({ pos: [5.3, 0.1, 0.5], normal: UP, area: 12, cla: 4.8, alpha0: 2.9, stall: 19, k: 0.115, flap: true, roll: 20, tau: 0.45 }, 'wingR', 'wingL'),
    // all-moving stabilators: pitch together, roll differentially. Deep in a stall their differential tilt is
    // what still yaws the aircraft: stick into the spin is the way out
    ...pair({ pos: [2.9, 0, 5.6], normal: UP, area: 7, cla: 3.3, stall: 20, k: 0.13, pitch: 25, roll: 12, tau: 1 }, 'stabR', 'stabL'),
    // twin fins with rudders, blanketed by the wing wake at high angle of attack
    ...pair({ pos: [1.75, 1.9, 4.6], normal: SIDE, area: 7.7, cla: 2.6, stall: 18, k: 0.2, yaw: 25, tau: 0.5, shield: 0.75 }, 'finR', 'finL'),
    // forebody side area: destabilising in yaw, as on the real aircraft
    { pos: [0, 0.2, -6.5], normal: SIDE, area: 5, cla: 0.6, stall: 12, k: 0.5 },
  ],
  parts: [
    // wings: 9 g limit x 1.5 = 13.5 g ultimate, of which a panel carries ~38%
    { id: 'wingR', tip: [7.35, 0.45, 3.4], maxLoad: 920e3 },
    { id: 'wingL', tip: [-7.35, 0.45, 3.4], maxLoad: 920e3 },
    // tails: full attached lift at ~60% of the limit dynamic pressure
    { id: 'stabR', tip: [4.5, 0.15, 6.5], maxLoad: 390e3 },
    { id: 'stabL', tip: [-4.5, 0.15, 6.5], maxLoad: 390e3 },
    { id: 'finR', tip: [2.25, 3.4, 5.4], maxLoad: 430e3 },
    { id: 'finL', tip: [-2.25, 3.4, 5.4], maxLoad: 430e3 },
  ],
  nose: [0, 0.1, -14.4],
  tail: [0, 0, 8.8],
  bodySide: 34,
  fbw: { gMax: 9, gMin: -3, alphaLimit: 17, alphaOverride: 45, rollRate: 2.2 },
  cd0: 0.022,
  waveDrag: [[0, 1], [0.8, 1], [0.95, 1.5], [1.05, 2.7], [1.3, 2.4], [2.0, 2.0], [2.6, 1.9]],
  inducedK: 0.115,
  spinYaw: 0.065,
  vne: 390,
  thrustDry: 150000,
  thrustAfterburner: 245000,
  cruiseSpeed: 250,
  maxSpeed: 690,
  gearHeight: 2.4,
  landingSinkLimit: 4.5,
  landingBankLimit: 12,
  flapClBonus: 0.45,
  flapCd: 0.025,
  gearCd: 0.018,
  speedbrakeCd: 0.05,
  brakeDecel: 4.5,
  stallAlpha: 20,
  nozzles: [{ pos: [0.95, -0.5, 10.8], r: 0.5 }, { pos: [-0.95, -0.5, 10.8], r: 0.5 }],
};

export const F117: AircraftConfig = {
  id: 'f117',
  name: 'F-117A NIGHTHAWK',
  hudLang: 'en',
  mass: 15000,
  inertia: [220000, 260000, 60000],
  wingArea: 70,
  wingSpan: 13.2,
  cg: [0, 0, 2.6],
  surfaces: [
    // faceted lifting body
    { pos: [0, 0, -1.3], normal: UP, area: 26, cla: 2.6, alpha0: 2.7, stall: 18, k: 0.16 },
    // 67-degree swept wing: the tips are far aft and carry the elevons (pitch and roll); no tailplane
    ...pair({ pos: [2.8, 0, 0.3], normal: UP, area: 12, cla: 3.6, alpha0: 2.7, stall: 15, k: 0.16, flap: true }, 'wingR', 'wingL'),
    ...pair({ pos: [5.2, 0.1, 2.6], normal: UP, area: 10, cla: 3.6, alpha0: 2.7, stall: 14, k: 0.16, pitch: 25, roll: 18, tau: 0.5 }, 'wingR', 'wingL'),
    // all-moving butterfly tail: yaw and pitch; small, so directional stability is weak
    { part: 'finR', pos: [1.9, 1.3, 5.8], normal: [0.707, -0.707, 0], area: 5, cla: 2.5, stall: 18, k: 0.2, yaw: 20, pitch: 20, tau: 1, shield: 0.5 },
    { part: 'finL', pos: [-1.9, 1.3, 5.8], normal: [0.707, 0.707, 0], area: 5, cla: 2.5, stall: 18, k: 0.2, yaw: 20, pitch: 20, tau: 1, shield: 0.5 },
    { pos: [0, 0.2, -5.5], normal: SIDE, area: 4, cla: 0.5, stall: 12, k: 0.5 },
  ],
  parts: [
    // 6 g limit x 1.5 = 9 g ultimate, a panel carries ~35%
    { id: 'wingR', tip: [6.6, 0.3, 4.25], maxLoad: 465e3 },
    { id: 'wingL', tip: [-6.6, 0.3, 4.25], maxLoad: 465e3 },
    { id: 'finR', tip: [3.0, 2.5, 6.9], maxLoad: 150e3 },
    { id: 'finL', tip: [-3.0, 2.5, 6.9], maxLoad: 150e3 },
  ],
  nose: [0, 0, -12.6],
  tail: [0, 0, 6.9],
  bodySide: 34,
  // the real aircraft is flown entirely by its computers: the limiter cannot be pulled through
  fbw: { gMax: 6, gMin: -2, alphaLimit: 12, alphaOverride: 12, rollRate: 1.0 },
  cd0: 0.03,
  waveDrag: [[0, 1], [0.75, 1], [0.9, 1.8], [1.0, 4], [1.3, 5]],
  inducedK: 0.16,
  spinYaw: 0,
  vne: 300,
  thrustDry: 96000,
  thrustAfterburner: 96000,
  cruiseSpeed: 240,
  maxSpeed: 310,
  gearHeight: 1.9,
  landingSinkLimit: 4.0,
  landingBankLimit: 10,
  flapClBonus: 0.35,
  flapCd: 0.03,
  gearCd: 0.022,
  speedbrakeCd: 0.06,
  brakeDecel: 4.0,
  stallAlpha: 15,
  nozzles: [{ pos: [0.68, -0.02, 10.2], r: 0.28 }, { pos: [-0.68, -0.02, 10.2], r: 0.28 }],
};

export const AIRCRAFT: Record<string, AircraftConfig> = { su27: SU27, f117: F117 };

export function tableLookup(table: AeroTable, x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1];
      const [x1, y1] = table[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return table[table.length - 1][1];
}

export interface AircraftMesh {
  vertices: Float32Array; // pos.xyz + normal.xyz per vertex
  ramps: Uint8Array;
  /** per vertex: 0 = fuselage, otherwise index into PART_IDS + 1 */
  parts: Uint8Array;
}

class MeshBuilder {
  verts: number[] = [];
  ramps: number[] = [];
  parts: number[] = [];
  /** part tag given to the triangles added next */
  private tag = 0;

  /** tag everything added inside `fn` as belonging to a separable part */
  part(id: PartId, fn: () => void): void {
    this.tag = PART_IDS.indexOf(id) + 1;
    fn();
    this.tag = 0;
  }

  tri(a: V3, b: V3, c: V3, ramp: number): void {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const p of [a, b, c]) {
      this.verts.push(p[0], p[1], p[2], nx, ny, nz);
      this.ramps.push(ramp);
      this.parts.push(this.tag);
    }
  }

  poly(points: V3[], ramp: number): void {
    for (let i = 1; i < points.length - 1; i++) this.tri(points[0], points[i], points[i + 1], ramp);
  }

  /** Loft between successive cross-section rings (equal point counts). */
  loft(rings: V3[][], ramp: number, capFront = true, capBack = true): void {
    for (let r = 0; r < rings.length - 1; r++) {
      const a = rings[r], b = rings[r + 1];
      if (a.length === 1) {
        for (let i = 0; i < b.length; i++) this.tri(a[0], b[(i + 1) % b.length], b[i], ramp);
        continue;
      }
      if (b.length === 1) {
        for (let i = 0; i < a.length; i++) this.tri(a[i], a[(i + 1) % a.length], b[0], ramp);
        continue;
      }
      for (let i = 0; i < a.length; i++) {
        const j = (i + 1) % a.length;
        this.poly([a[i], a[j], b[j], b[i]], ramp);
      }
    }
    if (capFront) this.poly([...rings[0]].reverse(), ramp);
    if (capBack) this.poly(rings[rings.length - 1], ramp);
  }

  build(): AircraftMesh {
    return { vertices: new Float32Array(this.verts), ramps: new Uint8Array(this.ramps), parts: new Uint8Array(this.parts) };
  }
}

const mirror = (p: V3): V3 => [-p[0], p[1], p[2]];

/** Su-27: blended wing body, twin fins, twin nozzles. Nose at -Z, ~200 tris. */
function buildSu27(): AircraftMesh {
  const m = new MeshBuilder();
  const HULL = RAMP.HULL_LIGHT;
  const DARK = RAMP.HULL_DARK;
  // fuselage rings: diamond-ish sections from nose (z=-11) to tail (z=+10.5)
  const ring = (z: number, w: number, top: number, bot: number): V3[] => [
    [0, top, z], [w, (top + bot) / 2 + 0.15, z], [0, bot, z], [-w, (top + bot) / 2 + 0.15, z],
  ];
  const nose = ring(-9.2, 0.55, 0.55, -0.45);
  m.loft([[[0, 0.1, -11]], nose], DARK, false, false); // radome
  m.loft([
    nose,
    ring(-6.5, 0.95, 0.95, -0.7),
    ring(-3.0, 1.25, 1.15, -0.8),
    ring(1.0, 1.5, 1.2, -0.85),
    ring(5.0, 1.6, 1.05, -0.8),
    ring(9.0, 1.5, 0.85, -0.65),
    ring(10.5, 1.35, 0.7, -0.55),
  ], HULL, false, true);
  // canopy
  m.poly([[0, 0.95, -6.5], [0.5, 1.35, -5.2], [0, 1.5, -3.6], [-0.5, 1.35, -5.2]], DARK);
  m.poly([[0.5, 1.35, -5.2], [0.7, 1.0, -3.2], [0, 1.5, -3.6]], DARK);
  m.poly([[-0.5, 1.35, -5.2], [0, 1.5, -3.6], [-0.7, 1.0, -3.2]], DARK);
  // wing glove + main wing (right, mirrored)
  const [wA, wB, wC, wD, wE, wF, wG]: V3[] = [
    [0.8, 0.2, -2.7], [1.4, 0.15, -2.5], [1.6, 0.1, 2.0], [7.35, 0.45, 6.2], [7.35, 0.45, 7.4], [2.0, 0.05, 5.5], [0.8, 0.1, 5.5],
  ];
  // explicit triangles (the planform is concave); every triangle gets an upward normal on both wings
  const upTri = (p: V3, q: V3, r: V3): void => {
    const ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
    if (ny >= 0) m.tri(p, q, r, HULL);
    else m.tri(p, r, q, HULL);
  };
  // the glove stays with the fuselage; the panel outboard of it is the separable wing
  for (const t of [[wA, wB, wC], [wA, wC, wG], [wG, wC, wF]] as V3[][]) {
    upTri(t[0], t[1], t[2]);
    upTri(mirror(t[0]), mirror(t[1]), mirror(t[2]));
  }
  for (const t of [[wC, wD, wE], [wC, wE, wF]] as V3[][]) {
    m.part('wingR', () => upTri(t[0], t[1], t[2]));
    m.part('wingL', () => upTri(mirror(t[0]), mirror(t[1]), mirror(t[2])));
  }
  // LERX strakes
  m.poly([[0.9, 0.4, -6.0], [1.4, 0.15, -2.5], [1.25, 0.3, -3.0]], HULL);
  m.poly([[-0.9, 0.4, -6.0], [-1.25, 0.3, -3.0], [-1.4, 0.15, -2.5]], HULL);
  // twin engine nacelles
  for (const s of [1, -1]) {
    const x = s * 0.95;
    m.loft([
      [[x, -0.2, 1.5], [x + s * 0.55, -0.5, 1.5], [x, -1.0, 1.5], [x - s * 0.55, -0.5, 1.5]],
      [[x, -0.15, 9.5], [x + s * 0.6, -0.5, 9.5], [x, -0.95, 9.5], [x - s * 0.6, -0.5, 9.5]],
      [[x, -0.2, 10.8], [x + s * 0.5, -0.5, 10.8], [x, -0.85, 10.8], [x - s * 0.5, -0.5, 10.8]],
    ], DARK, true, true);
  }
  // stabilators
  const stab: V3[] = [[1.0, 0.0, 6.5], [1.0, 0.0, 9.8], [4.6, 0.15, 10.6], [4.4, 0.15, 9.2]];
  m.part('stabR', () => m.poly(stab, HULL));
  m.part('stabL', () => m.poly([...stab].reverse().map(mirror), HULL));
  // twin canted fins
  for (const s of [1, -1]) {
    const fin: V3[] = [
      [s * 1.2, 0.25, 5.2], [s * 1.25, 0.25, 9.6],
      [s * 2.3, 3.4, 9.9], [s * 2.2, 3.4, 7.6],
    ];
    m.part(s > 0 ? 'finR' : 'finL', () => {
      m.poly(fin, HULL);
      m.poly([...fin].reverse(), HULL);
    });
  }
  // ventral fins
  for (const s of [1, -1]) {
    m.poly([[s * 0.9, -0.8, 7.0], [s * 1.0, -0.8, 9.8], [s * 1.3, -1.7, 9.6]], DARK);
  }
  // intake ramps under the LERX, flowing into the nacelles
  for (const s of [1, -1]) {
    const x = s * 0.95;
    m.loft([
      [[x, -0.3, -3.2], [x + s * 0.5, -0.55, -3.2], [x, -0.95, -3.2], [x - s * 0.5, -0.55, -3.2]],
      [[x, -0.2, 1.5], [x + s * 0.55, -0.5, 1.5], [x, -1.0, 1.5], [x - s * 0.55, -0.5, 1.5]],
    ], DARK, true, false);
  }
  // tailcone between nozzles
  m.loft([
    [[0, 0.3, 9.0], [0.5, 0.0, 9.0], [0, -0.4, 9.0], [-0.5, 0.0, 9.0]],
    [[0, 0.15, 12.2], [0.2, 0.0, 12.2], [0, -0.15, 12.2], [-0.2, 0.0, 12.2]],
  ], HULL, false, true);
  // wingtip launch rails
  for (const s of [1, -1]) m.part(s > 0 ? 'wingR' : 'wingL', () => {
    m.poly([[s * 7.25, 0.45, 6.0], [s * 7.45, 0.45, 6.0], [s * 7.45, 0.45, 7.8], [s * 7.25, 0.45, 7.8]], DARK);
    m.poly([[s * 7.25, 0.6, 6.0], [s * 7.25, 0.6, 7.8], [s * 7.45, 0.6, 7.8], [s * 7.45, 0.6, 6.0]], DARK);
    m.poly([[s * 7.25, 0.45, 6.0], [s * 7.25, 0.45, 7.8], [s * 7.25, 0.6, 7.8], [s * 7.25, 0.6, 6.0]], DARK);
    m.poly([[s * 7.45, 0.45, 6.0], [s * 7.45, 0.6, 6.0], [s * 7.45, 0.6, 7.8], [s * 7.45, 0.45, 7.8]], DARK);
    m.poly([[s * 7.25, 0.45, 6.0], [s * 7.25, 0.6, 6.0], [s * 7.45, 0.6, 6.0], [s * 7.45, 0.45, 6.0]], DARK);
    m.poly([[s * 7.25, 0.45, 7.8], [s * 7.45, 0.45, 7.8], [s * 7.45, 0.6, 7.8], [s * 7.25, 0.6, 7.8]], DARK);
  });
  return m.build();
}

/** F-117A: faceted diamond fuselage, sharply swept wing, V-tail. Nose at -Z. */
function buildF117(): AircraftMesh {
  const m = new MeshBuilder();
  const HULL = RAMP.HULL_DARK;
  const GLASS = RAMP.HULL_LIGHT;
  // diamond cross-sections: top ridge, chines, keel
  const ring = (z: number, w: number, top: number, chine: number, keel: number): V3[] => [
    [0, top, z], [w, chine, z], [0, keel, z], [-w, chine, z],
  ];
  m.loft([
    [[0, 0.0, -10.0]],
    ring(-8.6, 0.45, 0.3, -0.05, -0.35),
    ring(-8.0, 0.7, 0.45, -0.05, -0.5),
    ring(-6.5, 0.95, 0.7, -0.02, -0.65),
    ring(-5.0, 1.2, 1.0, 0.0, -0.8),
    ring(-3.2, 1.4, 1.15, 0.03, -0.85),
    ring(-1.5, 1.55, 1.25, 0.05, -0.9),
    ring(0.5, 1.6, 1.2, 0.05, -0.88),
    ring(2.5, 1.6, 1.1, 0.05, -0.85),
    ring(4.5, 1.5, 0.95, 0.02, -0.75),
    ring(6.5, 1.35, 0.8, 0.0, -0.65),
    ring(8.0, 1.2, 0.65, -0.02, -0.55),
    ring(9.5, 1.05, 0.5, -0.05, -0.45),
  ], HULL, false, true);
  // faceted canopy
  m.poly([[0, 1.0, -5.0], [0.55, 1.35, -3.9], [0, 1.55, -2.6], [-0.55, 1.35, -3.9]], GLASS);
  m.poly([[0.55, 1.35, -3.9], [0.6, 1.15, -2.2], [0, 1.55, -2.6]], GLASS);
  m.poly([[-0.55, 1.35, -3.9], [0, 1.55, -2.6], [-0.6, 1.15, -2.2]], GLASS);
  // highly swept wing with clipped delta planform
  const wing: V3[] = [
    [1.5, 0.05, -2.0], [6.6, 0.3, 6.4], [6.6, 0.3, 7.3], [1.6, 0.0, 5.8],
  ];
  m.part('wingR', () => m.poly(wing, HULL));
  m.part('wingL', () => m.poly([...wing].reverse().map(mirror), HULL));
  // wing underside facets (visible from below)
  const under: V3[] = [
    [1.5, -0.35, -1.5], [6.6, 0.1, 6.4], [6.6, 0.1, 7.3], [1.6, -0.4, 5.8],
  ];
  m.part('wingR', () => m.poly([...under].reverse(), HULL));
  m.part('wingL', () => m.poly(under.map(mirror), HULL));
  // V-tail (butterfly), canted 40°
  for (const s of [1, -1]) {
    const tail: V3[] = [
      [s * 0.9, 0.35, 6.8], [s * 1.0, 0.3, 9.6],
      [s * 3.1, 2.5, 10.4], [s * 2.9, 2.45, 8.6],
    ];
    m.part(s > 0 ? 'finR' : 'finL', () => {
      m.poly(tail, HULL);
      m.poly([...tail].reverse(), HULL);
    });
  }
  // flat exhaust slots
  for (const s of [1, -1]) {
    m.poly([
      [s * 0.35, 0.1, 9.5], [s * 1.0, 0.05, 9.5], [s * 1.0, -0.15, 10.2], [s * 0.35, -0.1, 10.2],
    ], RAMP.ASPHALT);
  }
  // sawtooth intake grilles on the upper chines
  for (const s of [1, -1]) {
    m.poly([[s * 1.25, 0.55, -3.0], [s * 1.5, 0.35, -1.6], [s * 1.45, 0.4, -0.2], [s * 1.2, 0.6, -1.4]], RAMP.ASPHALT);
    m.poly([[s * 1.25, 0.55, -3.0], [s * 1.2, 0.6, -1.4], [s * 1.05, 0.75, -2.2]], HULL);
  }
  return m.build();
}

const meshCache = new Map<string, AircraftMesh>();

export function aircraftMesh(id: 'su27' | 'f117'): AircraftMesh {
  let mesh = meshCache.get(id);
  if (!mesh) {
    mesh = id === 'su27' ? buildSu27() : buildF117();
    meshCache.set(id, mesh);
  }
  return mesh;
}

/**
 * F-19 style exhaust: a short, hard-edged amber cone with a bright core that
 * stretches and flickers with throttle; afterburner adds a long tail.
 * Normals are filled by the renderer (flame is self-lit).
 */
export function flameMesh(cfg: AircraftConfig, throttle: number, t: number): AircraftMesh {
  const m = new MeshBuilder();
  if (throttle < 0.04) return m.build();
  const ab = cfg.thrustAfterburner > cfg.thrustDry ? Math.max(0, (throttle - 0.85) / 0.15) : 0;
  const SIDES = 6;
  const circle = (cx: number, cy: number, z: number, r: number, phase: number): V3[] => {
    const pts: V3[] = [];
    for (let i = 0; i < SIDES; i++) {
      const a = phase + (i / SIDES) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r, z]);
    }
    return pts;
  };
  cfg.nozzles.forEach((n, k) => {
    const [cx, cy, z0] = n.pos;
    const flick = 1 + 0.10 * Math.sin(t * 47 + k * 2.1) + 0.07 * Math.sin(t * 91 + k * 0.7);
    const len = n.r * (1.0 + 3.0 * throttle + 7.0 * ab) * flick;
    const ph = k * 0.5;
    // amber outer plume: flared mouth, taper, tip
    m.loft([
      circle(cx, cy, z0 - 0.05, n.r * 0.92, ph),
      circle(cx, cy, z0 + len * 0.28, n.r * (ab > 0 ? 0.85 : 0.7), ph),
      [[cx, cy, z0 + len]],
    ], RAMP.HUD_AMBER, false, false);
    // bright core, shorter
    m.loft([
      circle(cx, cy, z0 - 0.02, n.r * 0.5, ph),
      circle(cx, cy, z0 + len * 0.22, n.r * 0.4, ph),
      [[cx, cy, z0 + len * 0.6]],
    ], RAMP.EMISSIVE, false, false);
    if (ab > 0.3) {
      // shock diamond further back
      const zd = z0 + len * 0.55;
      m.loft([
        [[cx, cy, zd - len * 0.12]],
        circle(cx, cy, zd, n.r * 0.55, ph),
        [[cx, cy, zd + len * 0.12]],
      ], RAMP.EMISSIVE, false, false);
    }
  });
  return m.build();
}
