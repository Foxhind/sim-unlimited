import { RAMP, TERRAIN_RAMP_BASE } from '../engine/palette';
import f117Model from './models/f117.json';
import su27Model from './models/su27.json';

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

/**
 * The configs below give every position (surfaces, part tips, nose and tail) in the model's own
 * coordinates, as measured on assets/models/<id>.blend; this moves them to the centre of gravity,
 * which is what the flight model works in. Moving `cg` then shifts the balance without moving the airframe.
 */
function fromModel(cfg: AircraftConfig): AircraftConfig {
  const rel = (p: V3): V3 => [p[0] - cfg.cg[0], p[1] - cfg.cg[1], p[2] - cfg.cg[2]];
  return {
    ...cfg,
    surfaces: cfg.surfaces.map((s) => ({ ...s, pos: rel(s.pos) })),
    parts: cfg.parts.map((p) => ({ ...p, tip: rel(p.tip) })),
    nose: rel(cfg.nose),
    tail: rel(cfg.tail),
  };
}

export const SU27: AircraftConfig = fromModel({
  id: 'su27',
  name: 'SU-27 FLANKER',
  hudLang: 'ru',
  mass: 18000,
  // the real aircraft's inertias, scaled from its 21.9 x 14.7 m to the model's 21.2 x 14.0 m
  inertia: [263000, 300000, 50000],
  // surface areas keep the model's proportions, scaled so the total lift matches the real 62 m2 wing
  wingArea: 62,
  wingSpan: 14.0,
  // the wing panels straddle the CG as on the real aircraft (inner ~0.5 m ahead, outer ~0.5 m aft): that is
  // what pitches the nose up at the stall; the neutral point stays 0.52 m behind it, as before
  cg: [0, 0, 1.4],
  surfaces: [
    // lifting body + leading-edge extensions: low aspect ratio, vortex lift that holds on to 30+ deg.
    // Its lift centre is set from the model's wing as on the real aircraft (1.4 m ahead of the inner panel):
    // the model's fuselage silhouette says little about where the vortex lift acts
    { pos: [0, 0, -0.47], normal: UP, area: 21, cla: 3.0, alpha0: 2.9, stall: 30, k: 0.115 },
    // wing panels: the swept outer part stalls first and sits aft, hence the pitch-up and wing drop
    ...pair({ pos: [3.41, 0, 0.93], normal: UP, area: 9.9, cla: 4.8, alpha0: 2.9, stall: 22, k: 0.115, flap: true }, 'wingR', 'wingL'),
    ...pair({ pos: [5.34, 0, 1.93], normal: UP, area: 13.1, cla: 4.8, alpha0: 2.9, stall: 19, k: 0.115, flap: true, roll: 20, tau: 0.45 }, 'wingR', 'wingL'),
    // all-moving stabilators: pitch together, roll differentially. Deep in a stall their differential tilt is
    // what still yaws the aircraft: stick into the spin is the way out. Placed as modelled; the model's
    // stabilators are drawn small, so the area keeps the real aircraft's tail volume (area x arm) instead
    ...pair({ pos: [3.75, -0.15, 8.04], normal: UP, area: 5.9, cla: 3.3, stall: 20, k: 0.13, pitch: 25, roll: 12, tau: 1 }, 'stabR', 'stabL'),
    // twin fins with rudders, blanketed by the wing wake at high angle of attack
    ...pair({ pos: [2.1, 1.6, 6.41], normal: SIDE, area: 5.1, cla: 2.6, stall: 18, k: 0.2, yaw: 25, tau: 0.5, shield: 0.75 }, 'finR', 'finL'),
    // forebody side area: destabilising in yaw, as on the real aircraft
    { pos: [0, -0.08, -3.0], normal: SIDE, area: 3.5, cla: 0.6, stall: 12, k: 0.5 },
  ],
  parts: [
    // wings: 9 g limit x 1.5 = 13.5 g ultimate, of which a panel carries ~40%
    { id: 'wingR', tip: [7.0, 0, 6.1], maxLoad: 960e3 },
    { id: 'wingL', tip: [-7.0, 0, 6.1], maxLoad: 960e3 },
    // tails: full attached lift at ~60% of the limit dynamic pressure
    { id: 'stabR', tip: [4.95, -0.1, 9.2], maxLoad: 330e3 },
    { id: 'stabL', tip: [-4.95, -0.1, 9.2], maxLoad: 330e3 },
    { id: 'finR', tip: [2.1, 3.4, 7.3], maxLoad: 290e3 },
    { id: 'finL', tip: [-2.1, 3.4, 7.3], maxLoad: 290e3 },
  ],
  nose: [0, -0.55, -10.6],
  tail: [0, 0, 10.6],
  // calibrated to the real aircraft's spin (the main yaw damping there), like cd0, not taken from the model
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
  nozzles: [{ pos: [1.18, -0.25, 9.0], r: 0.46 }, { pos: [-1.18, -0.25, 9.0], r: 0.46 }],
});

export const F117: AircraftConfig = fromModel({
  id: 'f117',
  name: 'F-117A NIGHTHAWK',
  hudLang: 'en',
  mass: 15000,
  inertia: [220000, 260000, 60000],
  // surface areas keep the model's proportions, scaled so the total lift matches the real 70 m2 wing
  wingArea: 70,
  wingSpan: 13.2,
  // the model's belly is flat at y = 0: the CG sits 0.9 m above it; static margin kept at ~7% of the mean chord
  cg: [0, 0.9, 0.55],
  surfaces: [
    // faceted lifting body
    { pos: [0, 0.3, 0.44], normal: UP, area: 24.9, cla: 2.6, alpha0: 2.7, stall: 18, k: 0.16 },
    // 67-degree swept wing: the tips are far aft and carry the elevons (pitch and roll); no tailplane
    ...pair({ pos: [2.59, 0.3, 0.47], normal: UP, area: 12.2, cla: 3.6, alpha0: 2.7, stall: 15, k: 0.16, flap: true }, 'wingR', 'wingL'),
    ...pair({ pos: [5.12, 0.4, 2.77], normal: UP, area: 10.2, cla: 3.6, alpha0: 2.7, stall: 14, k: 0.16, pitch: 25, roll: 18, tau: 0.5 }, 'wingR', 'wingL'),
    // all-moving butterfly tail, canted 28 deg from the vertical: yaw and pitch; small, so directional stability is weak
    { part: 'finR', pos: [0.91, 1.59, 6.87], normal: [0.883, -0.469, 0], area: 4.6, cla: 2.5, stall: 18, k: 0.2, yaw: 20, pitch: 20, tau: 1, shield: 0.5 },
    { part: 'finL', pos: [-0.91, 1.59, 6.87], normal: [0.883, 0.469, 0], area: 4.6, cla: 2.5, stall: 18, k: 0.2, yaw: 20, pitch: 20, tau: 1, shield: 0.5 },
    { pos: [0, 1.04, -2.9], normal: SIDE, area: 1.75, cla: 0.5, stall: 12, k: 0.5 },
  ],
  parts: [
    // 6 g limit x 1.5 = 9 g ultimate, a panel carries ~37%
    { id: 'wingR', tip: [6.6, 0.3, 7.2], maxLoad: 490e3 },
    { id: 'wingL', tip: [-6.6, 0.3, 7.2], maxLoad: 490e3 },
    { id: 'finR', tip: [1.5, 2.7, 10.09], maxLoad: 140e3 },
    { id: 'finL', tip: [-1.5, 2.7, 10.09], maxLoad: 140e3 },
  ],
  nose: [0, 0.3, -10],
  tail: [0, 0.3, 7.2],
  // calibrated to the real aircraft's spin (the main yaw damping there), like cd0, not taken from the model
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
  nozzles: [{ pos: [0.4, 0.25, 7.1], r: 0.22 }, { pos: [-0.4, 0.25, 7.1], r: 0.22 }],
});

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
  /** per vertex: palette ramp (a material ramp or TERRAIN_RAMP_BASE + VGA index) */
  ramps: Uint16Array;
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
    return { vertices: new Float32Array(this.verts), ramps: new Uint16Array(this.ramps), parts: new Uint8Array(this.parts) };
  }
}

/** what tools/export-aircraft.py writes from assets/models/<id>.blend */
interface ModelJson {
  /** 9 numbers per triangle, mesh space (x right, y up, z aft) */
  positions: number[];
  /** VGA palette index of each triangle */
  vga: number[];
  /** separable part of each triangle: 0 = fuselage, otherwise index into PART_IDS + 1 */
  parts: number[];
}

const MODELS: Record<AircraftConfig['id'], ModelJson> = { su27: su27Model, f117: f117Model };

/** Flat-shaded mesh of an exported model; each face keeps its VGA colour (lit through its terrain ramp). */
function loadModel(json: ModelJson): AircraftMesh {
  const m = new MeshBuilder();
  const P = json.positions;
  for (let t = 0; t < json.vga.length; t++) {
    const v = (k: number): V3 => [P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]];
    const tag = json.parts[t];
    const add = (): void => m.tri(v(0), v(1), v(2), TERRAIN_RAMP_BASE + json.vga[t]);
    if (tag) m.part(PART_IDS[tag - 1], add);
    else add();
  }
  return m.build();
}

const meshCache = new Map<string, AircraftMesh>();

export function aircraftMesh(id: 'su27' | 'f117'): AircraftMesh {
  let mesh = meshCache.get(id);
  if (!mesh) {
    mesh = loadModel(MODELS[id]);
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
