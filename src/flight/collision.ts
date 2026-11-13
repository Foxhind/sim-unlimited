/**
 * Aircraft against aircraft. Each airframe is a handful of spheres: four along the fuselage and two
 * on every separable part (mid-span and tip). A cheap bounding check comes first, so a pair of
 * aircraft that are not within touching distance costs one distance computation per step.
 *
 * A hit on a part tears that part off its owner; a hit on a fuselage destroys the aircraft.
 */
import { mat3, vec3 } from 'gl-matrix';
import type { AircraftConfig, PartId } from './aircraft';
import type { FlightModel } from './model';

export interface HitSphere {
  /** owning part; null = fuselage */
  part: PartId | null;
  /** centre in body axes, metres from the centre of gravity */
  pos: [number, number, number];
  r: number;
}

const sphereCache = new Map<string, { spheres: HitSphere[]; bound: number }>();

/** collision spheres of an airframe and the radius of the ball that contains them all */
export function hitSpheres(cfg: AircraftConfig): { spheres: HitSphere[]; bound: number } {
  let entry = sphereCache.get(cfg.id);
  if (entry) return entry;
  const spheres: HitSphere[] = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    spheres.push({
      part: null,
      pos: [0, cfg.nose[1] + (cfg.tail[1] - cfg.nose[1]) * t, cfg.nose[2] * 0.85 + (cfg.tail[2] * 0.85 - cfg.nose[2] * 0.85) * t],
      r: 1.7,
    });
  }
  for (const p of cfg.parts) {
    const wing = p.id.startsWith('wing');
    // root of the part: on the fuselage side, at the tip's own station along the fuselage
    const root: [number, number, number] = [Math.sign(p.tip[0]) * 1.2, wing ? p.tip[1] : 0.3, p.tip[2] - (wing ? 2 : 0.5)];
    for (const t of [0.55, 0.95]) {
      spheres.push({
        part: p.id,
        pos: [root[0] + (p.tip[0] - root[0]) * t, root[1] + (p.tip[1] - root[1]) * t, root[2] + (p.tip[2] - root[2]) * t],
        r: wing ? 1.3 : 1.0,
      });
    }
  }
  const bound = spheres.reduce((m, s) => Math.max(m, Math.hypot(s.pos[0], s.pos[1], s.pos[2]) + s.r), 0);
  entry = { spheres, bound };
  sphereCache.set(cfg.id, entry);
  return entry;
}

export interface AircraftHit {
  /** part of the first / second aircraft that was struck; null = its fuselage */
  a: PartId | null;
  b: PartId | null;
}

const rotA = mat3.create();
const rotB = mat3.create();
const pa = vec3.create();
const pb = vec3.create();

/**
 * Tests two aircraft over the last `dt` seconds of motion (swept, so a head-on pass at a combined
 * 500 m/s cannot tunnel through) and applies the damage. Returns what was hit, or null.
 * Call once per physics step per pair, after both models have been stepped.
 */
export function collideAircraft(a: FlightModel, b: FlightModel, dt: number): AircraftHit | null {
  if (a.crashed || b.crashed) return null;
  const A = hitSpheres(a.cfg);
  const B = hitSpheres(b.cfg);
  // relative motion over the step: where b was, seen from a, at the start of it
  const rvx = (b.vel[0] - a.vel[0]) * dt;
  const rvy = (b.vel[1] - a.vel[1]) * dt;
  const rvz = (b.vel[2] - a.vel[2]) * dt;
  const reach = A.bound + B.bound + Math.hypot(rvx, rvy, rvz);
  if (vec3.squaredDistance(a.pos, b.pos) > reach * reach) return null;

  mat3.fromQuat(rotA, a.quat);
  mat3.fromQuat(rotB, b.quat);
  let hit: AircraftHit | null = null;
  const seenA = new Set<PartId | null>();
  const seenB = new Set<PartId | null>();
  for (const sa of A.spheres) {
    if (sa.part && a.isLost(sa.part)) continue;
    vec3.transformMat3(pa, sa.pos as vec3, rotA);
    vec3.add(pa, pa, a.pos);
    for (const sb of B.spheres) {
      if (sb.part && b.isLost(sb.part)) continue;
      vec3.transformMat3(pb, sb.pos as vec3, rotB);
      vec3.add(pb, pb, b.pos);
      // closest approach of the two centres along the step: d(t) = d1 - rv * (1 - t), t in [0, 1]
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], dz = pb[2] - pa[2];
      const sx = dx - rvx, sy = dy - rvy, sz = dz - rvz; // separation at the start of the step
      const vv = rvx * rvx + rvy * rvy + rvz * rvz;
      const t = vv > 1e-9 ? Math.max(0, Math.min(1, -(sx * rvx + sy * rvy + sz * rvz) / vv)) : 1;
      const cx = sx + rvx * t, cy = sy + rvy * t, cz = sz + rvz * t;
      const rr = sa.r + sb.r;
      if (cx * cx + cy * cy + cz * cz > rr * rr) continue;
      hit ??= { a: sa.part, b: sb.part };
      seenA.add(sa.part);
      seenB.add(sb.part);
    }
  }
  if (!hit) return null;
  // each side is knocked toward the other's velocity: a glancing blow, not a merge
  const blowA = vec3.fromValues(rvx / dt, rvy / dt, rvz / dt);
  const blowB = vec3.negate(vec3.create(), blowA);
  const apply = (m: FlightModel, parts: Set<PartId | null>, blow: vec3): void => {
    if (parts.has(null)) {
      m.destroy('MIDAIR COLLISION');
      return;
    }
    const impulse = vec3.scale(vec3.create(), blow, 0.04 * m.cfg.mass);
    for (const p of parts) if (p) m.detach(p, 'collision', impulse);
  };
  apply(a, seenA, blowA);
  apply(b, seenB, blowB);
  // report the most serious contact: a fuselage hit outranks a part
  return { a: seenA.has(null) ? null : hit.a, b: seenB.has(null) ? null : hit.b };
}
