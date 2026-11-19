"""
Rig the Cessna 150 model (assets/models/c150.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py. The hull comes from tools/c150-build.py (its face attribute `comp` says
which assembly a face belongs to).

Run inside the open Blender (Text Editor > Run Script, the copy stored as `c150_rig.py`) or in the background:
  Blender -b assets/models/c150.blend --python tools/c150-rig.py -- --save
Rerunnable: the hull is restored from `C150_base` and the `C150 rig` collection is rebuilt.

Cessna 150: ailerons, single-slotted flaps to 40 deg, elevators, rudder. The gear is fixed and is part of the
hull, so is the propeller. Navigation lights on the wing tips, a white tail light, a red beacon on the fin,
the landing light in the cowling. The wings go with their struts; the fin stays with the fuselage.
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
from aircraft_rig import Rig, SIDES, vplane, store_scripts

# c150_build.py: Blender y = s - 2.2 (s = metres aft of the spinner tip), z = h - 0.1 (h = metres above the
# thrust line); the tyres touch 1.155 m below that line
Y0, Z0, GROUND_H = 2.2, 0.1, -1.155
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'strut': 4, 'gear': 5, 'prop': 6}
# the build script's sections: (half-span, s of the leading edge, chord, h)
WING = [(0.0, 1.80, 1.63, 0.88), (2.50, 1.80, 1.63, 0.924), (5.085, 2.13, 1.18, 0.969)]
STAB = [(0.0, 5.95, 0.95, 0.25), (1.525, 6.28, 0.68, 0.25)]
FIN = [(0.30, 5.40, 1.70), (0.55, 5.95, 1.15), (1.42, 6.62, 0.67)]   # h, s of the leading edge, chord
BODY_W = 0.53   # the fuselage's half-breadth under the wing: the wing inboard of it stays with the fuselage

rig = Rig('C150', 'C150', y0=Y0, ground_z=GROUND_H - Z0, door_mat='White_F2F3EF')
hbm = rig.hbm
comp = hbm.faces.layers.int['comp']
WHITE = 0


def P(s, w, h):
    return Vector((w, s - Y0, h - Z0))


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
        f.material_index = WHITE
        caps.append(f)
    bmesh.ops.recalc_face_normals(nb, faces=nb.faces)
    for f in caps:
        g = hbm.faces.new([hbm.verts.new(v.co) for v in reversed(f.verts)])
        g.material_index = WHITE
        g[comp] = COMP[assembly]
    return nb


def panel(name, assembly, sg, hs, box, pivot, axis, up, sample, want, terms, lim, part):
    """a control surface cut out of `assembly` on side sg (0: on the centre line)"""
    region = lambda f: f[comp] == COMP[assembly] and (sg == 0 or f.calc_center_median().x * sg > 0)
    lo = [min(box[0][k], box[1][k]) for k in range(3)]
    hi = [max(box[0][k], box[1][k]) for k in range(3)]
    nb = close(rig.extract(rig.cut(region, hs, (lo, hi))), hs, assembly)
    return rig.joint(name, nb, pivot, axis, up, sample, want, terms, lim=lim, part=part)


UP, DOWN = Vector((0, 0, 1)), Vector((0, 0, -1))
for side, sg in SIDES:
    def trailing(table, w0, w1, frac, name, terms, lim, want, part, assembly):
        """a trailing-edge surface from half-span w0 to w1, its hinge at `frac` of the chord"""
        a, b, m = at(table, w0), at(table, w1), at(table, (w0 + w1) / 2)
        h0 = P(a[1] + frac * a[2], sg * w0, a[3])
        h1 = P(b[1] + frac * b[2], sg * w1, b[3])
        mid = P(m[1] + m[2], sg * (w0 + w1) / 2, m[3])
        hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
        te = max(a[1] + a[2], b[1] + b[2])
        box = ((sg * w0, min(h0.y, h1.y), -5), (sg * w1, te - Y0, 5))
        return panel(name, assembly, sg, hs, box, h0, h1 - h0, UP, mid, want, terms, lim, part)

    # flaps from the fuselage side to the ailerons, the ailerons out to the tip fairing
    trailing(WING, 0.56, 2.80, 0.70, f'Flap_{side}', {'flaps': 40.0}, (0.0, 40.0), DOWN, 'wing' + side, 'wing')
    trailing(WING, 2.86, 4.98, 0.74, f'Aileron_{side}', {'roll': 20.0 * (1 if side == 'L' else -1)}, (-20.0, 20.0),
             DOWN, 'wing' + side, 'wing')
    # elevators: 25 deg up, 15 down
    trailing(STAB, 0.12, 1.50, 0.58, f'Elevator_{side}', {'pitch': 25.0}, (-15.0, 25.0), UP, 'stab' + side, 'stab')

# rudder: the fin's trailing edge above the tail cone
z0, z1 = 0.42, 1.36
a, b, m = at(FIN, z0), at(FIN, z1), at(FIN, (z0 + z1) / 2)
h0, h1 = P(a[1] + 0.62 * a[2], 0, z0), P(b[1] + 0.62 * b[2], 0, z1)
mid = P(m[1] + m[2], 0, m[0])
d = Vector((0, h1.y - h0.y, h1.z - h0.z)).normalized()
nh = Vector((1, 0, 0)).cross(d).normalized()
if (mid - h0).dot(nh) < 0:
    nh = -nh
hs = [(Vector((0, h0.y, h0.z)), nh), (P(0, 0, z0), UP), (P(0, 0, z1), DOWN)]
box = ((-0.2, min(h0.y, h1.y), z0 - Z0), (0.2, b[1] + b[2] - Y0 + 0.05, z1 - Z0))
panel('Rudder', 'fin', 0, hs, box, h0, h1 - h0, Vector((1, 0, 0)), mid, Vector((-1, 0, 0)), {'yaw': 23.0}, (-23.0, 23.0), None)
rig.finish_hull()
bpy.context.view_layer.update()

# lights
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    rig.light(f'NavLight_{side}', 'nav', P(2.30, sg * 5.11, 0.97), rgb, 'nav', 20.0)
rig.light('NavLight_Tail', 'nav', P(7.23, 0, 0.30), 'FFFFFF', 'nav', 20.0)
rig.light('Beacon_Top', 'beacon', P(6.96, 0, 1.46), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.0))
rig.light('LandingLight', 'landing', P(0.27, 0.20, -0.20), 'FFF2D6', 'landing', 200.0,
          spot_dir=Vector((0, -1, -0.1)).normalized())

# damage model: a wing goes with its strut from the fuselage side out; the tailplane halves outboard of the
# tail cone; the fin stays
me = rig.hull.data
for pid in aircraft_rig.PART_IDS:
    me.attributes.get('part_' + pid) or me.attributes.new('part_' + pid, 'BOOLEAN', 'FACE')
counts = {}
names = {v: k for k, v in COMP.items()}
for poly in me.polygons:
    kind = names[me.attributes['comp'].data[poly.index].value]
    side = 'L' if poly.center.x > 0 else 'R'
    inner = min(abs(me.vertices[i].co.x) for i in poly.vertices)
    pid = None
    if kind == 'strut' or (kind == 'wing' and inner >= BODY_W - 1e-3):
        pid = 'wing' + side
    elif kind == 'stab' and inner >= 0.1:
        pid = 'stab' + side
    for q in aircraft_rig.PART_IDS:
        me.attributes['part_' + q].data[poly.index].value = (q == pid)
    if pid:
        counts[pid] = counts.get(pid, 0) + 1
rig.counts = counts
# tip of each part in game coordinates (x right, y up, z aft) and the load that tears it off: 4.4 g limit x 1.5
# on 726 kg is 47 kN, of which a wing panel carries ~44%; a tailplane half lets go at 4.5 kN
rig.breaks({
    'wingR': ((5.085, 0.969 - Z0, 2.72 - Y0), 21000.0), 'wingL': ((-5.085, 0.969 - Z0, 2.72 - Y0), 21000.0),
    'stabR': ((1.525, 0.25 - Z0, 6.62 - Y0), 4500.0), 'stabL': ((-1.525, 0.25 - Z0, 6.62 - Y0), 4500.0),
})
result = rig.result()

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
    build = os.path.join(_here, 'c150-build.py')
    if os.path.isfile(build):
        t = bpy.data.texts.get('c150_build.py') or bpy.data.texts.new('c150_build.py')
        t.clear()
        t.write(open(build).read())
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
print('RESULT', result)
