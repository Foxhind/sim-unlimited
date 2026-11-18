"""
Rig the F-16AM model (assets/models/f16.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py. The hull comes from tools/f16-build.py (its face attribute `comp` says
which assembly a face belongs to).

Run inside the open Blender (Text Editor > Run Script, the copy stored as `f16_rig.py`) or in the background:
  Blender -b assets/models/f16.blend --python tools/f16-rig.py -- --save
Rerunnable: the hull is restored from `F-16_base` and the `F16 rig` collection is rebuilt.

F-16: flaperons (roll and landing flap), leading-edge flaps, all-moving stabilators (pitch and roll), rudder,
the split speedbrakes beside the nozzle; the nose leg retracting aft, the main legs forward with their wheels
turning flat, with doors; red and green position lights on the intake sides, white tail light, a red
anti-collision light on the fin, landing light on the nose leg.
"""
import bpy, bmesh, math, os, sys
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
from aircraft_rig import Rig, SIDES, STOW, WELL, vplane, prism, wheel, store_scripts

# f16_build.py: Blender y = s - 10.6 (s = metres aft of the radome tip), z = h (metres above the wing plane);
# the tyres touch 1.7 m below it
Y0, GROUND_H = 10.6, -1.70
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'ventral': 4, 'boom': 5, 'tip': 6, 'canopy': 7, 'nozzle': 8}
# the build script's sections: (half-span, s of the leading edge, chord, h)
WING = [(0.55, 4.3, 8.6, 0.0), (0.95, 6.5, 6.4, 0.0), (1.35, 9.03, 3.87, 0.0), (4.57, 11.73, 1.17, 0.0)]
FIN = [(0.3, 10.69, 3.84), (3.31, 13.9, 1.05)]     # h, s of the leading edge, chord

rig = Rig('F-16', 'F16', y0=Y0, ground_z=GROUND_H, door_mat='Light_A9AFB2')
hbm = rig.hbm
comp = hbm.faces.layers.int['comp']
SKIN = 0   # the first hull material: the upper-surface grey


def P(s, w, h):
    return Vector((w, s - Y0, h))


def at(table, x):
    """the section of a lifting surface at half-span (or height) x, interpolated"""
    for a, b in zip(table, table[1:]):
        if a[0] - 1e-6 <= x <= b[0] + 1e-6:
            t = (x - a[0]) / (b[0] - a[0])
            return [a[k] + (b[k] - a[k]) * t for k in range(len(a))]
    raise ValueError(x)


def close(nb, hs, assembly):
    """The panel cut out by the half-spaces `hs` is an open shell: close it along the cut planes, and close
    the hole it leaves in the hull with the same polygons facing the other way."""
    bverts = {v for e in nb.edges if e.is_boundary for v in e.verts}
    caps = []
    for co, no in hs:
        vs = [v for v in bverts if abs((v.co - co).dot(no)) < 1e-4]
        if len(vs) < 3:
            continue
        c = sum((v.co for v in vs), Vector()) / len(vs)
        u = max((v.co - c for v in vs), key=lambda d: d.length)
        u = (u - u.dot(no) * no).normalized()
        w = no.cross(u)
        vs.sort(key=lambda v: math.atan2((v.co - c).dot(w), (v.co - c).dot(u)))
        f = nb.faces.new(vs)
        if f.calc_area() < 1e-6:
            nb.faces.remove(f)
            continue
        f.material_index = SKIN
        caps.append(f)
    bmesh.ops.recalc_face_normals(nb, faces=nb.faces)
    for f in caps:
        g = hbm.faces.new([hbm.verts.new(v.co) for v in reversed(f.verts)])
        g.material_index = SKIN
        g[comp] = COMP[assembly]
    return nb


def panel(name, assembly, sg, hs, box, pivot, axis, up, sample, want, terms, lim, part):
    """a control surface cut out of `assembly` on side sg (sg = 0: the centreline)"""
    region = lambda f: f[comp] == COMP[assembly] and (sg == 0 or f.calc_center_median().x * sg > 0)
    lo = [min(box[0][k], box[1][k]) for k in range(3)]
    hi = [max(box[0][k], box[1][k]) for k in range(3)]
    nb = close(rig.extract(rig.cut(region, hs, (lo, hi))), hs, assembly)
    return rig.joint(name, nb, pivot, axis, up, sample, want, terms, lim=lim, part=part)


UP, DOWN = Vector((0, 0, 1)), Vector((0, 0, -1))
for side, sg in SIDES:
    wing_part = 'wing' + side
    spanwise = lambda w0, w1: [(P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]

    # flaperon: 0.72 m of the trailing edge from the strake to 3.35 m; roll and the landing flap
    w0, w1, d = 1.45, 3.35, 0.72
    a, b, m = at(WING, w0), at(WING, w1), at(WING, (w0 + w1) / 2)
    h0, h1 = P(a[1] + a[2] - d, sg * w0, 0), P(b[1] + b[2] - d, sg * w1, 0)
    mid = P(m[1] + m[2], sg * (w0 + w1) / 2, 0)
    box = ((sg * w0, h0.y, -1), (sg * w1, a[1] + a[2] - Y0, 1))
    panel(f'Flaperon_{side}', 'wing', sg, [vplane(h0, h1, mid)] + spanwise(w0, w1), box, h0, h1 - h0, UP, mid, DOWN,
          {'flaps': 20.0, 'roll': 21.0 * (1 if side == 'L' else -1)}, (-21.0, 21.0), wing_part)

    # leading-edge flap: the front 22% of the chord from the strake to the tip; droops with the flaps
    w0, w1, f = 1.45, 4.45, 0.22
    a, b, m = at(WING, w0), at(WING, w1), at(WING, (w0 + w1) / 2)
    h0, h1 = P(a[1] + f * a[2], sg * w0, 0), P(b[1] + f * b[2], sg * w1, 0)
    mid = P(m[1], sg * (w0 + w1) / 2, 0)
    box = ((sg * w0, a[1] - Y0, -1), (sg * w1, h1.y, 1))
    panel(f'LEFlap_{side}', 'wing', sg, [vplane(h0, h1, mid)] + spanwise(w0, w1), box, h0, h1 - h0, UP, mid, DOWN,
          {'flaps': 25.0}, (0.0, 25.0), wing_part)

    # all-moving stabilator: the whole surface, turning about a spanwise axis at 40% of its root chord
    faces = [f for f in hbm.faces if f[comp] == COMP['stab'] and f.calc_center_median().x * sg > 0]
    rig.joint(f'Stabilator_{side}', rig.extract(faces), P(12.75 + 0.4 * 2.2, sg * 0.95, -0.05), Vector((1, 0, 0)), UP,
              P(15.0, sg * 2.5, -0.3), UP, {'pitch': 25.0, 'roll': 8.0 * (-1 if side == 'L' else 1)}, lim=(-25.0, 25.0),
              part='stab' + side)

    # split speedbrakes: the aft 1.2 m of each boom's upper and lower skin, hinged at the front edge
    for name, up, want in (('Upper', 1, UP), ('Lower', -1, DOWN)):
        def skin(f, sg=sg, up=up):
            f.normal_update()
            return f[comp] == COMP['boom'] and f.normal.z * up > 0.9 and f.calc_center_median().x * sg > 0
        hs = [(P(13.75, 0, 0), Vector((0, 1, 0)))]
        box = ((min(sg * 0.6, sg * 0.97), 13.75 - Y0, -0.3), (max(sg * 0.6, sg * 0.97), 14.95 - Y0, 0.3))
        nb = rig.extract(rig.cut(skin, hs, box), keep_copy=0.06 * up)
        for fc in list(nb.faces):   # the petal's inner side
            g = nb.faces.new([nb.verts.new(v.co - Vector((0, 0, 0.02 * up))) for v in reversed(fc.verts)])
            g.material_index = rig.MI[WELL]
        hz = 0.18 if up > 0 else -0.20
        rig.joint(f'Speedbrake{name}_{side}', nb, P(13.75, sg * 0.62, hz), Vector((1, 0, 0)), UP, P(14.95, sg * 0.8, hz),
                  want, {'speedbrake': 60.0}, lim=(0.0, 60.0))

# rudder: the fin's trailing edge from 0.75 m to 3.0 m above the wing plane
z0, z1 = 0.75, 3.0
a, b, m = at(FIN, z0), at(FIN, z1), at(FIN, (z0 + z1) / 2)
h0, h1 = P(a[1] + a[2] - 0.85, 0, z0), P(b[1] + b[2] - 0.55, 0, z1)
mid = P(m[1] + m[2], 0, m[0])
dl = Vector((0, h1.y - h0.y, h1.z - h0.z)).normalized()
nh = Vector((1, 0, 0)).cross(dl).normalized()
if (mid - h0).dot(nh) < 0:
    nh = -nh
hs = [(Vector((0, h0.y, h0.z)), nh), (P(0, 0, z0), UP), (P(0, 0, z1), DOWN)]
panel('Rudder', 'fin', 0, hs, ((-0.3, h0.y, z0), (0.3, b[1] + b[2] - Y0, z1)), h0, h1 - h0, Vector((1, 0, 0)), mid,
      Vector((-1, 0, 0)), {'yaw': 30.0}, (-30.0, 30.0), None)

for f in hbm.faces:   # the speedbrake recesses belong to the booms
    if f.material_index == rig.MI[WELL]:
        f[comp] = COMP['boom']
rig.finish_hull()
bpy.context.view_layer.update()


def leg(strut_name, wheel_name, s, x_piv, x_wheel, r, width, half, foot, want, flat=None):
    """a strut from the hull underside at x_piv to a wheel at x_wheel, stowing towards `want`;
    flat: the side ('L'/'R') if the wheel turns flat while it stows"""
    piv = P(s, x_piv, rig.under(x_piv, s - Y0))
    wc = P(s, x_wheel, rig.ground_z + r)
    bm = bmesh.new()
    prism(bm, piv, wc + Vector((0, 0, -foot)), half, 0)
    strut = rig.joint(strut_name, bm, piv, Vector((1, 0, 0)), UP, wc, want, STOW, bias=90.0, lim=(0.0, 90.0),
                      show=('gear_leg', 0.02), mats=rig.gear_mats)
    bm = bmesh.new()
    wheel(bm, wc, Vector((1, 0, 0)), r, width, 8, 1, 0)
    if flat:
        sgw = 1.0 if flat == 'L' else -1.0
        rig.joint(wheel_name, bm, wc, Vector((0, 0, 1)), Vector((0, 1, 0)), wc + Vector((0, -r, 0)), Vector((sgw, 0, 0)),
                  STOW, bias=90.0, lim=(0.0, 90.0), parent=strut, show=('gear_leg', 0.02), mats=rig.gear_mats)
    else:
        rig.joint(wheel_name, bm, wc, Vector((1, 0, 0)), UP, wc + Vector((0, 0, -r)), Vector((0, 1, 0)), {},
                  parent=strut, show=('gear_leg', 0.02), mats=rig.gear_mats)
    return strut, piv, wc


# nose leg under the intake, 4.0 m ahead of the mains, retracting aft; 0.46 m wheel
nose = leg('NoseGear', 'NoseWheel', 7.0, 0.0, 0.0, 0.23, 0.15, 0.05, 0.04, Vector((0, 1, 0)))
for side, sg in SIDES:
    rig.door(f'NoseDoor_{side}', 6.2, 7.6, 0.04, 0.32, sg, {'gear_door': 85.0})
# main legs on the 2.36 m track from the fuselage belly, retracting forward with the wheels turning flat
for side, sg in SIDES:
    leg(f'MainGear_{side}', f'MainWheel_{side}', 11.0, sg * 0.6, sg * 1.18, 0.34, 0.22, 0.06, 0.05,
        Vector((0, -1, 0)), flat=side)
    rig.door(f'MainDoor_{side}', 10.1, 11.7, 0.14, 0.58, sg, {'gear_door': 90.0})
bpy.context.view_layer.update()

# lights: red and green on the intake sides, white on the fin's trailing edge, the anti-collision light on top
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    hit = rig.ray((sg * 3.0, 5.4 - Y0, -0.35), (-sg, 0, 0))
    rig.light(f'NavLight_{side}', 'nav', hit + Vector((sg * 0.03, 0, 0)), rgb, 'nav', 20.0)
rig.light('NavLight_Tail', 'nav', P(14.97, 0, 3.15), 'FFFFFF', 'nav', 20.0)
rig.light('Beacon_Top', 'beacon', P(14.3, 0, 3.36), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.0))
rig.landing_light(*nose)

# damage model: the wings with what is outboard of the fuselage (their rails and missiles too); the
# stabilators are separate objects; the single fin stays with the fuselage
me = rig.hull.data
for pid in aircraft_rig.PART_IDS:
    me.attributes.get('part_' + pid) or me.attributes.new('part_' + pid, 'BOOLEAN', 'FACE')
counts = {}
names = {v: k for k, v in COMP.items()}
for poly in me.polygons:
    kind = names[me.attributes['comp'].data[poly.index].value]
    side = 'L' if poly.center.x > 0 else 'R'
    pid = None
    if kind == 'tip' or (kind == 'wing' and min(abs(me.vertices[i].co.x) for i in poly.vertices) >= 0.9):
        pid = 'wing' + side
    for q in aircraft_rig.PART_IDS:
        me.attributes['part_' + q].data[poly.index].value = (q == pid)
    if pid:
        counts[pid] = counts.get(pid, 0) + 1
rig.counts = counts
# tip of each part in game coordinates (x right, y up, z aft) and the load that tears it off: 9 g x 1.5 on
# 10.5 t is 1.39 MN, of which a wing panel carries ~37%; a stabilator half of its full attached lift
rig.breaks({
    'wingR': ((4.98, 0.0, 12.0 - Y0), 520e3), 'wingL': ((-4.98, 0.0, 12.0 - Y0), 520e3),
    'stabR': ((2.79, -0.37, 15.0 - Y0), 170e3), 'stabL': ((-2.79, -0.37, 15.0 - Y0), 170e3),
})
result = rig.result()

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
    build = os.path.join(_here, 'f16-build.py')
    if os.path.isfile(build):
        t = bpy.data.texts.get('f16_build.py') or bpy.data.texts.new('f16_build.py')
        t.clear()
        t.write(open(build).read())
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
    print('RESULT', result)
