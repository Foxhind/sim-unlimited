"""
Rig the An-225 model (assets/models/an225.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py. The hull comes from tools/an225-build.py (its face attribute `comp` says
which assembly a face belongs to).

Run inside the open Blender (Text Editor > Run Script, the copy stored as `an225_rig.py`) or in the background:
  Blender -b assets/models/an225.blend --python tools/an225-rig.py -- --save
Rerunnable: the hull is restored from `An-225_base` and the `AN225 rig` collection is rebuilt.

An-225: ailerons, two flap sections and a spoiler panel per wing, elevators, twin rudders; two twin-wheel nose
legs retracting forward and seven twin-wheel main legs a side folding inwards into the fairings, with doors;
navigation lights on the wing tips, white tail light, two red beacons, landing light on a nose leg.
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

# an225_build.py: Blender y = s - 36.8 (s = metres aft of the nose tip), z = h - 1.0 (h = metres above the
# fuselage reference line); the tyres touch 5.5 m below that line
Y0, Z0, GROUND_H = 36.8, 1.0, -5.5
COMP = {'fuselage': 0, 'fairing': 1, 'wing': 2, 'stab': 3, 'fin': 4, 'nacelle': 5, 'pylon': 6}
# the build script's sections: (half-span, s of the leading edge, chord, h)
WING = [(0.0, 25.4, 18.2, 3.55), (3.7, 25.4, 18.2, 3.55), (13.5, 31.2, 12.4, 3.13), (28.0, 40.6, 8.3, 2.5),
        (44.2, 51.1, 3.8, 1.8)]
STAB = [(0.0, 67.2, 9.0, 4.6), (16.33, 74.4, 6.6, 6.3)]
FIN_X, FIN_H, FIN_CANT = 16.33, 6.3, 7.0
FIN = [(6.3, 74.0, 9.0), (12.6, 80.3, 3.7)]     # h, s of the leading edge, chord

rig = Rig('An-225', 'AN225', y0=Y0, ground_z=GROUND_H - Z0, door_mat='Grey_B9BDC1')
# the fairings hang below Rig.under's probe and the fins stand above Rig.over's
rig.under = lambda x, y: rig.ray((x, y, -30.0), (0, 0, 1)).z
rig.over = lambda x, y: rig.ray((x, y, 30.0), (0, 0, -1)).z
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
        if f.calc_area() < 1e-5:
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
    """a control surface cut out of `assembly` on side sg"""
    region = lambda f: f[comp] == COMP[assembly] and f.calc_center_median().x * sg > 0
    lo = [min(box[0][k], box[1][k]) for k in range(3)]
    hi = [max(box[0][k], box[1][k]) for k in range(3)]
    nb = close(rig.extract(rig.cut(region, hs, (lo, hi))), hs, assembly)
    return rig.joint(name, nb, pivot, axis, up, sample, want, terms, lim=lim, part=part)


UP, DOWN = Vector((0, 0, 1)), Vector((0, 0, -1))
for side, sg in SIDES:
    wing_part = 'wing' + side

    def trailing(table, w0, w1, frac, name, terms, lim, want, part, assembly):
        """a trailing-edge surface from half-span w0 to w1, its hinge at `frac` of the chord"""
        a, b, m = at(table, w0), at(table, w1), at(table, (w0 + w1) / 2)
        h0 = P(a[1] + frac * a[2], sg * w0, a[3])
        h1 = P(b[1] + frac * b[2], sg * w1, b[3])
        mid = P(m[1] + m[2], sg * (w0 + w1) / 2, m[3])
        hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
        te = max(a[1] + a[2], b[1] + b[2])
        box = ((sg * w0, min(h0.y, h1.y), -20), (sg * w1, te - Y0, 20))
        return panel(name, assembly, sg, hs, box, h0, h1 - h0, UP, mid, want, terms, lim, part)

    # flaps: the unswept inner section and the outer one; ailerons outboard of them
    trailing(WING, 4.4, 13.0, 0.79, f'FlapIn_{side}', {'flaps': 30.0}, (0.0, 30.0), DOWN, wing_part, 'wing')
    trailing(WING, 14.0, 29.4, 0.75, f'FlapOut_{side}', {'flaps': 30.0}, (0.0, 30.0), DOWN, wing_part, 'wing')
    trailing(WING, 30.2, 43.4, 0.72, f'Aileron_{side}', {'roll': 20.0 * (1 if side == 'L' else -1)}, (-20.0, 20.0),
             DOWN, wing_part, 'wing')
    trailing(STAB, 1.4, 15.2, 0.68, f'Elevator_{side}', {'pitch': 20.0}, (-20.0, 20.0), UP, 'stab' + side, 'stab')

    # spoilers: a panel of the upper skin ahead of the outer flap, hinged on its front edge
    w0, w1 = 15.0, 28.6
    a, b, m = at(WING, w0), at(WING, w1), at(WING, (w0 + w1) / 2)
    f0, f1 = P(a[1] + 0.60 * a[2], sg * w0, 0), P(b[1] + 0.60 * b[2], sg * w1, 0)
    r0, r1 = P(a[1] + 0.73 * a[2], sg * w0, 0), P(b[1] + 0.73 * b[2], sg * w1, 0)
    hs = [vplane(f0, f1, r0), vplane(r0, r1, f0), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]

    def upper_skin(f, sg=sg):
        f.normal_update()
        return f[comp] == COMP['wing'] and f.normal.z > 0.5 and f.calc_center_median().x * sg > 0

    lo, hi = (min(sg * w0, sg * w1), f0.y, -20), (max(sg * w0, sg * w1), r1.y, 20)
    nb = rig.extract(rig.cut(upper_skin, hs, (lo, hi)), keep_copy=0.12)
    for f in list(nb.faces):   # the panel's underside
        g = nb.faces.new([nb.verts.new(v.co + Vector((0, 0, -0.03))) for v in reversed(f.verts)])
        g.material_index = rig.MI[WELL]
    piv0 = Vector((f0.x, f0.y, rig.over(f0.x, f0.y + 0.02)))
    piv1 = Vector((f1.x, f1.y, rig.over(f1.x, f1.y + 0.02)))
    rear = Vector(((r0.x + r1.x) / 2, (r0.y + r1.y) / 2, (piv0.z + piv1.z) / 2))
    rig.joint(f'Spoiler_{side}', nb, piv0, piv1 - piv0, UP, rear, UP, {'speedbrake': 45.0}, lim=(0.0, 45.0), part=wing_part)

    # rudder: the fin's trailing edge above the tailplane; the fins lean in by FIN_CANT
    fin_x = lambda h: sg * (FIN_X - (h - FIN_H) * math.tan(math.radians(FIN_CANT)))
    z0, z1 = 7.0, 12.2
    a, b, m = at(FIN, z0), at(FIN, z1), at(FIN, (z0 + z1) / 2)
    h0, h1 = P(a[1] + 0.66 * a[2], fin_x(z0), z0), P(b[1] + 0.66 * b[2], fin_x(z1), z1)
    mid = P(m[1] + m[2], fin_x(m[0]), m[0])
    d = Vector((0, h1.y - h0.y, h1.z - h0.z)).normalized()
    nh = Vector((1, 0, 0)).cross(d).normalized()
    if (mid - h0).dot(nh) < 0:
        nh = -nh
    hs = [(Vector((0, h0.y, h0.z)), nh), (P(0, 0, z0), UP), (P(0, 0, z1), DOWN)]
    box = ((sg * 14.0, h0.y, z0 - Z0), (sg * 18.0, b[1] + b[2] - Y0, z1 - Z0))
    panel(f'Rudder_{side}', 'fin', sg, hs, box, h0, h1 - h0, Vector((sg, 0, 0)), mid, Vector((-1, 0, 0)),
          {'yaw': 25.0}, (-25.0, 25.0), 'fin' + side)

for f in hbm.faces:   # the spoiler recesses belong to the wing
    if f.material_index == rig.MI[WELL] and abs(f.calc_center_median().x) > 5.0:
        f[comp] = COMP['wing']
rig.finish_hull()
bpy.context.view_layer.update()


# gear: every leg is one hinged object carrying its strut and a pair of wheels
def leg(name, s, x, r, width, gap, half, pivot_z, axis, want):
    piv = Vector((x, s - Y0, pivot_z))
    wc = Vector((x, s - Y0, rig.ground_z + r))
    bm = bmesh.new()
    prism(bm, piv, wc, half, 0)
    prism(bm, wc - Vector((gap / 2, 0, 0)), wc + Vector((gap / 2, 0, 0)), half * 0.7, 0)
    for k in (-1, 1):
        wheel(bm, wc + Vector((k * gap / 2, 0, 0)), Vector((1, 0, 0)), r, width, 8, 1, 0)
    ob = rig.joint(name, bm, piv, axis, UP, wc, want, STOW, bias=90.0, lim=(0.0, 90.0), show=('gear_leg', 0.02),
                   mats=rig.gear_mats)
    return ob, piv, wc


def door(name, s0, s1, w_in, w_out, sg, terms, n_s=2):
    """a door under the hull hinged on its outer edge, following the skin over n_s spans"""
    def rows(depth):
        return [[rig.P(s0 + (s1 - s0) * i / n_s, w, rig.under(w, s0 + (s1 - s0) * i / n_s - Y0) - depth)
                 for w in (sg * w_in, sg * w_out)] for i in range(n_s + 1)]
    outer, inner = rows(0.02), rows(0.012)
    bm = bmesh.new()
    vo = [[bm.verts.new(p) for p in row] for row in outer]
    vi = [[bm.verts.new(p) for p in row] for row in inner]
    for i in range(n_s):
        bm.faces.new((vo[i][0], vo[i][1], vo[i + 1][1], vo[i + 1][0])).material_index = 3
        bm.faces.new((vi[i + 1][0], vi[i + 1][1], vi[i][1], vi[i][0])).material_index = 2
    bm.normal_update()
    for f in bm.faces:   # outer skin faces down, the well side up
        if (f.normal.z > 0) == (f.material_index == 3):
            f.normal_flip()
    h0, h1 = outer[0][1], outer[-1][1]
    return rig.joint(name, bm, h0, h1 - h0, UP, (outer[0][0] + outer[-1][0]) / 2, DOWN, terms, lim=(0.0, 90.0),
                     mats=rig.gear_mats)


# nose: two legs 2.4 m apart at station 9.5 (wheelbase 29.1 m to the middle main axle), 1.12 m wheels
nose = {}
for side, sg in SIDES:
    nose[side] = leg(f'NoseGear_{side}', 9.5, sg * 1.2, 0.56, 0.4, 0.95, 0.11, rig.under(sg * 1.2, 9.5 - Y0),
                     Vector((1, 0, 0)), Vector((0, -1, 0)))
    door(f'NoseDoor_{side}', 8.3, 10.7, 0.65, 1.85, sg, {'gear_door': 85.0})
# mains: seven legs a side on the real 8.84 m track, axles 1.82 m apart from station 33.1, 1.27 m wheels;
# they fold inwards into the fairings
for side, sg in SIDES:
    for i in range(7):
        leg(f'MainGear_{side}{i + 1}', 33.1 + 1.82 * i, sg * 4.42, 0.635, 0.48, 1.1, 0.13, -4.15 - Z0,
            Vector((0, 1, 0)), Vector((-sg, 0, 0)))
    door(f'MainDoor_{side}', 32.0, 45.2, 3.75, 4.45, sg, {'gear_door': 80.0})
bpy.context.view_layer.update()

# lights
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    rig.light(f'NavLight_{side}', 'nav', P(52.4, sg * 44.25, 1.85), rgb, 'nav', 40.0)
rig.light('NavLight_Tail', 'nav', P(78.7, 0, 3.9), 'FFFFFF', 'nav', 40.0)
rig.light('Beacon_Top', 'beacon', rig.P(20.0, 0, rig.over(0, 20.0 - Y0) + 0.06), 'FF2200', 'beacon', 120.0, blink=(1.0, 0.12, 0.0))
rig.light('Beacon_Bottom', 'beacon', rig.P(24.0, 0, rig.under(0, 24.0 - Y0) - 0.06), 'FF2200', 'beacon', 120.0, blink=(1.0, 0.12, 0.5))
rig.landing_light(*nose['L'])

# damage model: the build script's assemblies; a wing takes its engines and pylons with it, the centre
# section inside the fuselage stays
me = rig.hull.data
for pid in aircraft_rig.PART_IDS:
    me.attributes.get('part_' + pid) or me.attributes.new('part_' + pid, 'BOOLEAN', 'FACE')
counts = {}
names = {v: k for k, v in COMP.items()}
for poly in me.polygons:
    kind = names[me.attributes['comp'].data[poly.index].value]
    side = 'L' if poly.center.x > 0 else 'R'
    pid = None
    if kind in ('nacelle', 'pylon') or (kind == 'wing' and min(abs(me.vertices[i].co.x) for i in poly.vertices) >= 3.69):
        pid = 'wing' + side
    elif kind in ('stab', 'fin'):
        pid = kind + side
    for q in aircraft_rig.PART_IDS:
        me.attributes['part_' + q].data[poly.index].value = (q == pid)
    if pid:
        counts[pid] = counts.get(pid, 0) + 1
rig.counts = counts
# tip of each part in game coordinates (x right, y up, z aft) and the load that tears it off: 2.5 g x 1.5 on
# 640 t is 23.5 MN, of which a wing panel carries ~42%; the tails take a tenth of that
tip_fin = P(82.1, FIN_X - (12.6 - FIN_H) * math.tan(math.radians(FIN_CANT)), 12.6)
rig.breaks({
    'wingR': ((44.2, 1.8 - Z0, 53.0 - Y0), 9.9e6), 'wingL': ((-44.2, 1.8 - Z0, 53.0 - Y0), 9.9e6),
    'stabR': ((16.33, 6.3 - Z0, 77.7 - Y0), 1.6e6), 'stabL': ((-16.33, 6.3 - Z0, 77.7 - Y0), 1.6e6),
    'finR': ((tip_fin.x, tip_fin.z, tip_fin.y), 1.3e6), 'finL': ((-tip_fin.x, tip_fin.z, tip_fin.y), 1.3e6),
})
result = rig.result()

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
    build = os.path.join(_here, 'an225-build.py')
    if os.path.isfile(build):
        t = bpy.data.texts.get('an225_build.py') or bpy.data.texts.new('an225_build.py')
        t.clear()
        t.write(open(build).read())
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
    print('RESULT', result)
