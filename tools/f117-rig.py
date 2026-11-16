"""
Rig the F-117 model (assets/models/f117.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py.

Run inside the open Blender (Text Editor > Run Script, the copy stored as `f117_rig.py`) or in the background:
  Blender -b assets/models/f117.blend --python tools/f117-rig.py -- --save
Rerunnable: the hull is restored from `F-117_base` and the `F117 rig` collection is rebuilt.

F-117: two elevons on each side of the W-shaped trailing edge (pitch and roll; the inboard ones also droop
as flaps, which is how the flight model treats the inner wing); the all-moving butterfly tail, each half a
ruddervator (pitch and yaw). No airbrake is drawn: the speedbrake switch only adds drag. Tricycle gear
retracting forward with sequenced doors; navigation lights on the wing tips, white tail light, two red
beacons, landing light on the nose strut.
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

# f117_build.py: Blender y = s - 10 (s = metres aft of the nose), belly at z = 0; the CG is 0.9 m above
# the belly and the tyres touch gearHeight = 1.9 m below it
rig = Rig('F-117', 'F117', y0=10.0, ground_z=-1.0, door_mat='VGA_019_2D2D2D')
P, Y0 = rig.P, rig.y0

# trailing edge from the wing root notch R (14.2, 2.4) to the tip E2 (17.2, 6.6), and its unit normal
# in plan pointing forward into the wing (s, w)
TE_D = Vector((3.0, 4.2)).normalized()
TE_N = Vector((-TE_D.y, TE_D.x))          # (-0.814, +0.581): forward and outboard


def te(w):
    """trailing-edge point at half-breadth w, as (s, w)"""
    return Vector((14.2 + (w - 2.4) * 3.0 / 4.2, w))


ELEVONS = (  # name, w at the trailing edge from .. to, chord, flap droop
    ('In', 2.75, 4.45, 0.75, 20.0),
    ('Out', 4.6, 6.3, 0.65, 0.0),
)
for side, sg in SIDES:
    in_wing = lambda f, sg=sg: all(v.co.x * sg >= 2.05 for v in f.verts)
    for name, w0, w1, chord, droop in ELEVONS:
        a, b = te(w0), te(w1)
        ha, hb = a + TE_N * chord, b + TE_N * chord
        Pa, Pb = P(a.x, sg * a.y, 0.3), P(b.x, sg * b.y, 0.3)
        Ha, Hb = P(ha.x, sg * ha.y, 0.3), P(hb.x, sg * hb.y, 0.3)
        mid = (Pa + Pb) / 2 + (Ha - Pa) * 0.2
        hs = [vplane(Ha, Hb, mid), vplane(Pa, Ha, mid), vplane(Pb, Hb, mid)]
        xs = [p.x for p in (Pa, Pb, Ha, Hb)]
        ys = [p.y for p in (Pa, Pb, Ha, Hb)]
        box = ((min(xs), min(ys), -1.0), (max(xs), max(ys), 2.0))
        bm = rig.extract(rig.cut(in_wing, hs, box))
        # positive = trailing edge up: pull raises both, roll right raises the right ones
        terms = {'pitch': 25.0, 'roll': 18.0 * (-1 if side == 'L' else 1)}
        if droop:
            terms['flaps'] = -droop
        rig.joint(f'Elevon{name}_{side}', bm, Ha, Hb - Ha, Vector((0, 0, 1)), (Pa + Pb) / 2, Vector((0, 0, 1)),
                  terms, lim=(-30.0, 30.0), part='wing' + side)

    # butterfly tail: each half is a double-sided plate (f117_build.py), all-moving about a spanwise axis
    corners = [P(s, sg * w, z) for s, w, z in ((14.6, .25, 1.0), (17.0, .25, .35), (20.09, 1.5, 2.7), (18.0, 1.5, 2.7))]
    on_tail = lambda f, c=corners: all(min((v.co - q).length for q in c) < 1e-3 for v in f.verts)
    bm = rig.extract([f for f in rig.hbm.faces if on_tail(f)])
    root = corners[0].lerp(corners[1], 0.45)
    tip = corners[3].lerp(corners[2], 0.45)
    span = (tip - root).normalized()
    up = span.cross(corners[1] - corners[0]).normalized()
    if up.z < 0:
        up = -up                        # the side of the plate that faces up (and inboard)
    te_mid = (corners[1] + corners[2]) / 2
    # pull: trailing edges up; right pedal: trailing edges to the right (Blender -x)
    yaw = 20.0 * (1 if up.x < 0 else -1)
    rig.joint(f'Ruddervator_{side}', bm, root, span, up, te_mid, up,
              {'pitch': 20.0, 'yaw': yaw}, lim=(-30.0, 30.0), part='fin' + side)
rig.finish_hull()

# gear: nose wheel under the cockpit, mains just aft of the CG; all retract forward into the belly
strut_n, n_piv, n_wc = rig.gear('NoseGear', 'NoseWheel', 4.6, 0.0, 0.3, 0.2, 0.06, 0.04)
for side, sg in SIDES:
    rig.door(f'NoseDoor_{side}', 3.5, 4.9, 0.03, 0.36, sg, {'gear_door': 85.0})
for side, sg in SIDES:
    rig.gear(f'MainGear_{side}', f'MainWheel_{side}', 11.4, sg * 1.6, 0.4, 0.25, 0.07, 0.05)
    rig.door(f'MainDoor_{side}', 10.2, 11.6, 1.2, 1.95, sg, {'gear_door': 90.0})
bpy.context.view_layer.update()

# lights: red on the left wing tip, green on the right, white at the tail
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    rig.light(f'NavLight_{side}', 'nav', P(16.4, sg * 6.63, 0.3), rgb, 'nav', 20.0)
rig.light('NavLight_Tail', 'nav', P(17.25, 0, 0.3), 'FFFFFF', 'nav', 20.0)
rig.light('Beacon_Top', 'beacon', P(11.0, 0, rig.over(0, 11.0 - Y0) + 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.0))
rig.light('Beacon_Bottom', 'beacon', P(12.5, 0, rig.under(0, 12.5 - Y0) - 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.5))
rig.landing_light(strut_n, n_piv, n_wc)


# damage model: the wing outboard of the body (game coordinates, mirrored to x >= 0)
def part_of(pts):
    right = [(abs(p[0]), p[1], p[2]) for p in pts]
    c = [sum(p[k] for p in right) / len(right) for k in range(3)]
    side = 'R' if sum(p[0] for p in pts) > 0 else 'L'
    if c[0] > 1.9 and c[1] < 0.75:
        return 'wing' + side
    return None   # the tail halves are separate objects


rig.paint_parts(part_of)
# 6 g limit x 1.5 = 9 g ultimate, a wing panel carries ~37%
rig.breaks({
    'wingR': ((6.6, 0.3, 7.2), 490e3), 'wingL': ((-6.6, 0.3, 7.2), 490e3),
    'finR': ((1.5, 2.7, 10.09), 140e3), 'finL': ((-1.5, 2.7, 10.09), 140e3),
})
result = rig.result()

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
    print('RESULT', result)
