"""
Rig the Su-27 model (assets/models/su27.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py.

Run inside the open Blender (Text Editor > Run Script, the copy stored as `su27_rig.py`) or in the background:
  Blender -b assets/models/su27.blend --python tools/su27-rig.py -- --save
Rerunnable: the hull is restored from `Su-27_base` and the `SU27 rig` collection is rebuilt.

Su-27: flaperons, leading-edge flaps, all-moving stabilators, rudders, the dorsal airbrake; nose and main
gear (the mains turn their wheels flat as they stow) with sequenced doors; navigation lights on the intake
sides, white tail light, two red beacons, landing light on the nose strut.
"""
import bpy, os, sys
from mathutils import Vector

_here = os.path.dirname(os.path.abspath(__file__)) if os.path.isfile(globals().get('__file__', '')) else None
if _here and _here not in sys.path:
    sys.path.insert(0, _here)
import importlib, types
try:
    import aircraft_rig
    importlib.reload(aircraft_rig)
except ImportError:  # run from the .blend's Text Editor: the shared module is the text block stored next to it
    aircraft_rig = types.ModuleType('aircraft_rig')
    exec(compile(bpy.data.texts['aircraft_rig.py'].as_string(), 'aircraft_rig.py', 'exec'), aircraft_rig.__dict__)
    sys.modules['aircraft_rig'] = aircraft_rig
from aircraft_rig import Rig, SIDES, vplane, store_scripts

# su27_build.py: Blender y = s - 11.3 (s = metres aft of the nose datum); the tyres touch 2.4 m below the CG
rig = Rig('Su-27', 'SU27', y0=11.3, ground_z=-2.4, door_mat='VGA_078_7DBEFF')
P, Y0 = rig.P, rig.y0


def te_s(w):      # wing trailing edge O7 (16.0, 2.5) -> O6 (17.4, 7.0)
    return 16.0 + (w - 2.5) * 1.4 / 4.5


def le_s(w):      # wing leading edge O4 (11.0, 2.5) -> O5 (15.5, 7.0)
    return 11.0 + (w - 2.5)


for side, sg in SIDES:
    wing_part = 'wing' + side
    in_wing = lambda f, sg=sg: all(v.co.x * sg >= 2.45 and -0.3 < v.co.z < 0.05 for v in f.verts)

    # flaperon: inboard 2.65 .. 5.6 m, 0.8 .. 0.6 m chord; roll and landing flap
    w0, w1 = 2.65, 5.6
    h0, h1 = P(te_s(w0) - 0.8, sg * w0, 0), P(te_s(w1) - 0.6, sg * w1, 0)
    mid = P(te_s(4.0) - 0.1, sg * 4.0, 0)
    hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
    box = ((min(sg * w0, sg * w1), h0.y, -1), (max(sg * w0, sg * w1), te_s(w1) - Y0, 1))
    rig.joint(f'Flaperon_{side}', rig.extract(rig.cut(in_wing, hs, box)), h0, h1 - h0, Vector((0, 0, 1)), mid,
              Vector((0, 0, -1)), {'flaps': 35.0, 'roll': 20.0 * (1 if side == 'L' else -1)}, lim=(-20.0, 35.0),
              part=wing_part)

    # leading-edge flap: 2.65 .. 6.85 m, 0.5 .. 0.3 m chord
    w0, w1 = 2.65, 6.85
    h0, h1 = P(le_s(w0) + 0.5, sg * w0, 0), P(le_s(w1) + 0.3, sg * w1, 0)
    mid = P(le_s(4.5) + 0.05, sg * 4.5, 0)
    hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
    box = ((min(sg * w0, sg * w1), le_s(w0) - Y0, -1), (max(sg * w0, sg * w1), h1.y, 1))
    rig.joint(f'LEFlap_{side}', rig.extract(rig.cut(in_wing, hs, box)), h0, h1 - h0, Vector((0, 0, 1)), mid,
              Vector((0, 0, -1)), {'flaps': 30.0}, lim=(0.0, 30.0), part=wing_part)

    # all-moving stabilator: the whole surface, pivot at 45% of the root chord
    in_stab = lambda f, sg=sg: all(v.co.x * sg >= 2.35 and v.co.z <= -0.09 for v in f.verts) \
        and f.calc_center_median().y > 5.5
    bm = rig.extract([f for f in rig.hbm.faces if in_stab(f)])
    root = [e for e in rig.hbm.edges if e.is_boundary and all(v.co.x * sg >= 2.38 and v.co.y > 5.5 and v.co.z < 0.0 for v in e.verts)]
    # only the fuselage side is closed: a cap on the stabilator too would lie on top of it at rest
    import bmesh
    bmesh.ops.holes_fill(rig.hbm, edges=root, sides=0)
    rig.joint(f'Stabilator_{side}', bm, P(18.4, sg * 2.45, -0.15), Vector((1, 0, 0)), Vector((0, 0, 1)),
              P(19.9, sg * 3.5, -0.1), Vector((0, 0, 1)),
              {'pitch': 25.0, 'roll': 12.0 * (-1 if side == 'L' else 1)}, lim=(-25.0, 25.0), part='stab' + side)

    # rudder: upper two thirds of the fin trailing edge (fins are plates at x = 2.1, built by su27_build.py)
    fin_te = lambda z: 19.0 - z / 3.4 * 0.4
    z0, z1 = 0.9, 3.0
    h0, h1 = P(fin_te(z0) - 0.85, sg * 2.1, z0), P(fin_te(z1) - 0.4, sg * 2.1, z1)
    mid = P(fin_te(2.0) - 0.1, sg * 2.1, 2.0)
    in_fin = lambda f, sg=sg: all(2.05 < v.co.x * sg < 2.15 and v.co.z > -0.05 for v in f.verts)
    nh = Vector((1, 0, 0)).cross((h1 - h0).normalized()).normalized()
    if (mid - h0).dot(nh) < 0:
        nh = -nh
    hs = [(h0, nh), (P(0, 0, z0), Vector((0, 0, 1))), (P(0, 0, z1), Vector((0, 0, -1)))]
    box = ((min(sg * 2.0, sg * 2.2), h0.y, z0), (max(sg * 2.0, sg * 2.2), fin_te(z0) - Y0, z1))
    rig.joint(f'Rudder_{side}', rig.extract(rig.cut(in_fin, hs, box)), h0, h1 - h0, Vector((sg, 0, 0)), mid,
              Vector((-1, 0, 0)), {'yaw': 25.0}, lim=(-25.0, 25.0), part='fin' + side)

# dorsal airbrake behind the canopy: hinged at its front edge, opens 54 deg
in_spine = lambda f: all(v.co.z > 0.25 and abs(v.co.x) < 0.95 and -3.0 < v.co.y < 1.5 for v in f.verts)
hs = [(P(8.9, 0, 0), Vector((0, 1, 0))), (P(11.6, 0, 0), Vector((0, -1, 0))),
      (P(0, 0.6, 0), Vector((-1, 0, 0))), (P(0, -0.6, 0), Vector((1, 0, 0)))]
bm = rig.extract(rig.cut(in_spine, hs, ((-0.6, 8.9 - Y0, 0), (0.6, 11.6 - Y0, 2))), keep_copy=0.12)
rig.joint('Airbrake', bm, P(8.9, 0, rig.over(0, 8.9 - Y0)), Vector((1, 0, 0)), Vector((0, 0, 1)),
          P(11.6, 0, 0.8), Vector((0, 0, 1)), {'speedbrake': 54.0}, lim=(0.0, 54.0))
rig.finish_hull()

# gear: nose wheel 0.68 m retracting forward into the fuselage; 1.03 m main wheels at the real 4.3 m track,
# retracting forward and turning flat
strut_n, n_piv, n_wc = rig.gear('NoseGear', 'NoseWheel', 7.4, 0.0, 0.34, 0.24, 0.07, 0.05)
for side, sg in SIDES:
    rig.door(f'NoseDoor_{side}', 6.0, 7.9, 0.03, 0.34, sg, {'gear_door': 85.0})
for side, sg in SIDES:
    rig.gear(f'MainGear_{side}', f'MainWheel_{side}', 13.3, sg * 2.1, 0.52, 0.3, 0.09, 0.08, flat=side)
    rig.door(f'MainDoor_{side}', 11.2, 13.6, 1.78, 2.35, sg, {'gear_door': 90.0})
bpy.context.view_layer.update()

# lights
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    hit = rig.ray((sg * 4.0, 10.4 - Y0, -0.7), (-sg, 0, 0))
    rig.light(f'NavLight_{side}', 'nav', hit + Vector((sg * 0.03, 0, 0)), rgb, 'nav', 20.0)
rig.light('NavLight_Tail', 'nav', P(21.95, 0, 0.0), 'FFFFFF', 'nav', 20.0)
rig.light('Beacon_Top', 'beacon', P(12.4, 0, rig.over(0, 12.4 - Y0) + 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.0))
rig.light('Beacon_Bottom', 'beacon', P(12.6, 0, rig.under(0, 12.6 - Y0) - 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.5))
rig.landing_light(strut_n, n_piv, n_wc)


# damage model: which separable part each hull face belongs to (game coordinates, mirrored to x >= 0)
def part_of(pts):
    right = [(abs(p[0]), p[1], p[2]) for p in pts]
    c = [sum(p[k] for p in right) / len(right) for k in range(3)]
    side = 'R' if sum(p[0] for p in pts) > 0 else 'L'
    if all(1.95 < p[0] < 2.3 for p in right) and max(p[1] for p in right) > 0.5:
        return 'fin' + side
    if all(p[0] >= 2.45 for p in right) and abs(c[1]) < 0.3:
        return 'wing' + side
    return None   # the stabilators are separate objects; what is left at their roots is the fuselage


rig.paint_parts(part_of)
# tip of each part (probed against terrain) and the load that tears it off: wings 9 g x 1.5 = 13.5 g ultimate,
# of which a panel carries ~40%; tails: full attached lift at ~60% of the limit dynamic pressure
rig.breaks({
    'wingR': ((7.0, 0, 6.1), 960e3), 'wingL': ((-7.0, 0, 6.1), 960e3),
    'stabR': ((4.95, -0.1, 9.2), 330e3), 'stabL': ((-4.95, -0.1, 9.2), 330e3),
    'finR': ((2.1, 3.4, 7.3), 290e3), 'finL': ((-2.1, 3.4, 7.3), 290e3),
})
result = rig.result()

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
    print('RESULT', result)
