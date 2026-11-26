"""
Rig the P-51D Mustang model (assets/models/p51.blend) for the game; the shared machinery and what it builds are
described in tools/aircraft_rig.py. The hull comes from tools/p51-build.py (its face attribute `comp` says
which assembly a face belongs to).

Run inside the open Blender (Text Editor > Run Script, the copy stored as `p51_rig.py`) or in the background:
  Blender -b assets/models/p51.blend --python tools/p51-rig.py -- --save
Rerunnable: the hull is restored from `P51_base` and the `P51 rig` collection is rebuilt.

P-51D: ailerons, plain flaps to 50 deg, elevators, rudder. The main legs swing inward into the wing roots, their
fairing plates closing the wells, with the inner well doors under the fuselage; the tail wheel retracts forward
behind two doors. Navigation lights on the wing tips and the tail, the landing light in the left wheel well
(lit with the gear down). No anti-collision beacon: the type never had one. The wings go from the fuselage side
out with their legs; the tailplane halves outboard of the tail cone; the fin stays.
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
from aircraft_rig import Rig, SIDES, STOW, vplane, prism, wheel, store_scripts

# p51_build.py: Blender y = s - 3.85 (s = metres aft of the spinner tip), z = h + 0.1 (h = metres above the
# thrust line); standing level the main tyres touch 1.95 m below that line
Y0, Z0, GROUND_H = 3.85, -0.10, -1.95
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'scoop': 4, 'canopy': 5, 'prop': 6}
# the build script's sections: (half-span, s of the leading edge, chord, h)
DIH, WING_H = math.tan(math.radians(5.0)), -0.50
WING = [(w, s, c, WING_H + w * DIH) for w, s, c in
        ((0.0, 2.75, 2.85), (0.45, 2.78, 2.82), (1.40, 3.10, 2.42), (5.40, 3.80, 1.22), (5.64, 3.97, 0.92))]
STAB = [(0.0, 8.35, 1.35, 0.12), (2.08, 8.85, 0.72, 0.12)]
FIN = [(0.30, 7.00, 2.75), (0.45, 7.60, 2.15), (0.62, 8.35, 1.42), (1.55, 8.75, 0.95), (1.80, 9.00, 0.62)]
BODY_W = 0.45   # the fuselage's half-breadth at the wing: the wing inboard of it stays with the fuselage
# gear: main wheels on the 3.61 m track ahead of the CG, raked forward from their pivots behind the spar;
# the tail wheel where the three-point attitude (10 deg nose up) puts its tyre on the ground
MAIN_S, MAIN_PIV_S, MAIN_W, MAIN_R, MAIN_WIDTH = 3.30, 3.50, 1.805, 0.345, 0.18
TAIL_S, TAIL_PIV_S, TAIL_R, TAIL_WIDTH = 8.45, 8.30, 0.16, 0.09
THREE_POINT = math.radians(10.0)

rig = Rig('P51', 'P51', y0=Y0, ground_z=GROUND_H - Z0, door_mat='Alu_B9BEC2')
hbm = rig.hbm
comp = hbm.faces.layers.int['comp']
SKIN = 0   # the first hull material: natural metal


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
        f.material_index = SKIN
        caps.append(f)
    bmesh.ops.recalc_face_normals(nb, faces=nb.faces)
    for f in caps:
        g = hbm.faces.new([hbm.verts.new(v.co) for v in reversed(f.verts)])
        g.material_index = SKIN
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

    # flaps from the fuselage side to the ailerons, the ailerons out to the rounded tip
    trailing(WING, 0.50, 3.25, 0.76, f'Flap_{side}', {'flaps': 50.0}, (0.0, 50.0), DOWN, 'wing' + side, 'wing')
    trailing(WING, 3.31, 5.30, 0.76, f'Aileron_{side}', {'roll': 15.0 * (1 if side == 'L' else -1)}, (-15.0, 15.0),
             DOWN, 'wing' + side, 'wing')
    # elevators: 30 deg up, 20 down
    trailing(STAB, 0.12, 2.0, 0.62, f'Elevator_{side}', {'pitch': 30.0}, (-20.0, 30.0), UP, 'stab' + side, 'stab')

# rudder: the fin's aft part behind the straight hinge line, from the tail cone up to under the rounded top
z0, z1, HINGE_S = 0.45, 1.72, 9.15
h0, h1 = P(HINGE_S, 0, z0), P(HINGE_S, 0, z1)
m = at(FIN, (z0 + z1) / 2)
mid = P(m[1] + m[2], 0, m[0])
hs = [(Vector((0, h0.y, h0.z)), Vector((0, 1, 0))), (P(0, 0, z0), UP), (P(0, 0, z1), DOWN)]
box = ((-0.2, h0.y, z0 - Z0), (0.2, 9.85 - Y0, z1 - Z0))
panel('Rudder', 'fin', 0, hs, box, h0, h1 - h0, Vector((1, 0, 0)), mid, Vector((-1, 0, 0)), {'yaw': 30.0}, (-30.0, 30.0), None)
rig.finish_hull()
bpy.context.view_layer.update()


def leg(strut_name, wheel_name, piv, wc, axis, want, r, width, half, part=None, fairing=None):
    """a strut from the pivot to the wheel centre, turning about `axis` to stow with the wheel moving towards
    `want`; fairing: (x of the plate, s0, s1) - the leg's cover outboard of the tyre, which closes the well"""
    bm = bmesh.new()
    prism(bm, piv, wc + (wc - piv).normalized() * 0.04, half, 0)
    if fairing:
        x, s0, s1 = fairing
        top, bot = piv.z - 0.02, wc.z + 0.05
        for dx, mi, flip in ((0.0, 3, False), (-0.012 * (1 if x > 0 else -1), 2, True)):
            q = [bm.verts.new(Vector((x + dx, s0 - Y0, top))), bm.verts.new(Vector((x + dx, s1 - Y0, top))),
                 bm.verts.new(Vector((x + dx, s1 - Y0, bot))), bm.verts.new(Vector((x + dx, s0 - Y0, bot)))]
            if (x > 0) != flip:
                q.reverse()
            bm.faces.new(q).material_index = mi
    strut = rig.joint(strut_name, bm, piv, axis, UP, wc, want, STOW, bias=90.0, lim=(0.0, 90.0),
                      show=('gear_leg', 0.02), mats=rig.gear_mats, part=part)
    bm = bmesh.new()
    wheel(bm, wc, Vector((1, 0, 0)), r, width, 10, 1, 0)
    rig.joint(wheel_name, bm, wc, Vector((1, 0, 0)), UP, wc + Vector((0, 0, -r)), Vector((0, 1, 0)), {},
              parent=strut, show=('gear_leg', 0.02), mats=rig.gear_mats)
    return strut, piv, wc


def skin_door(name, outline, hinge, terms, lim=90.0):
    """A gear door lying in the skin it closes: `outline` (x, s) round the opening, `hinge` two (x, s) points on
    it; every vertex is dropped onto the hull underside below it (a fan of two rings, so the door follows the
    belly's and the wing root's curve instead of spanning them flat), the outer side 20 mm under the skin and
    the well-coloured inner side 8 mm above that, as aircraft_rig.door does. The free edge swings down."""
    c = (sum(x for x, s in outline) / len(outline), sum(s for x, s in outline) / len(outline))
    rings = [[c] * len(outline), [((x + c[0]) / 2, (s + c[1]) / 2) for x, s in outline], outline]
    bm = bmesh.new()
    for depth, mi, down in ((0.02, 3, True), (0.012, 2, False)):
        vs = [[bm.verts.new(Vector((x, s - Y0, rig.under(x, s - Y0) - depth))) for x, s in ring]
              for ring in rings]
        n = len(outline)
        for i in range(2):
            for j in range(n):
                k = (j + 1) % n
                q = [vs[i][j], vs[i][k], vs[i + 1][k], vs[i + 1][j]]
                if i == 0:
                    q = q[1:]   # the centre is one point
                f = bm.faces.new(list(dict.fromkeys(q)))
                f.material_index = mi
                f.normal_update()
                if (f.normal.z < 0) != down:
                    f.normal_flip()
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    (x0, s0), (x1, s1) = hinge
    h0 = Vector((x0, s0 - Y0, rig.under(x0, s0 - Y0) - 0.02))
    h1 = Vector((x1, s1 - Y0, rig.under(x1, s1 - Y0) - 0.02))
    far = max(outline, key=lambda p: abs((p[0] - x0) * (s1 - s0) - (p[1] - s0) * (x1 - x0)))
    sample = Vector((far[0], far[1] - Y0, rig.under(far[0], far[1] - Y0)))
    return rig.joint(name, bm, h0, h1 - h0, UP, sample, DOWN, terms, lim=(0.0, lim), mats=rig.gear_mats)


def circle(cx, cs, r, n=12):
    return [(cx + r * math.cos(2 * math.pi * k / n), cs + r * math.sin(2 * math.pi * k / n)) for k in range(n)]


def rect(x0, x1, s0, s1, n_s=4):
    """the outline of a door from x0 to x1 across, s0 to s1 along, its long edges cut n_s times"""
    left = [(x0, s0 + (s1 - s0) * i / n_s) for i in range(n_s + 1)]
    right = [(x1, s1 - (s1 - s0) * i / n_s) for i in range(n_s + 1)]
    return left + right


# main legs: from under the wing behind the spar, swinging inward; the inner doors under the wing roots
mains = {}
for side, sg in SIDES:
    wc = P(MAIN_S, sg * MAIN_W, GROUND_H + MAIN_R)
    piv = P(MAIN_PIV_S, sg * MAIN_W, 0)
    piv.z = rig.under(piv.x, piv.y)
    mains[side] = leg(f'MainGear_{side}', f'MainWheel_{side}', piv, wc, Vector((0, 1, 0)), Vector((-sg, 0, 0)),
                      MAIN_R, MAIN_WIDTH, 0.05, part='wing' + side,
                      fairing=(sg * (MAIN_W + MAIN_WIDTH / 2 + 0.03), MAIN_S - 0.30, MAIN_PIV_S + 0.12))
    # the inner door: a disc round the stowed wheel (the leg swings it inward about the pivot, level with it),
    # hinged on its inboard edge under the fuselage side
    piv_, wc_ = mains[side][1], mains[side][2]
    cx, r = piv_.x - sg * (piv_.z - wc_.z), MAIN_R + 0.03
    skin_door(f'MainDoor_{side}', circle(cx, MAIN_S, r), ((cx - sg * r, MAIN_S - 0.3), (cx - sg * r, MAIN_S + 0.3)),
              {'gear_door': 85.0})
# the tail wheel: its tyre on the ground of the three-point attitude, retracting forward
tail_ground = (GROUND_H - Z0) + (TAIL_S - MAIN_S) * math.tan(THREE_POINT)
twc = Vector((0.0, TAIL_S - Y0, tail_ground + TAIL_R))
tpiv = Vector((0.0, TAIL_PIV_S - Y0, rig.under(0.0, TAIL_PIV_S - Y0)))
tail = leg('TailGear', 'TailWheel', tpiv, twc, Vector((1, 0, 0)), Vector((0, -1, 0)), TAIL_R, TAIL_WIDTH, 0.035)
# two doors under the tail cone, over the stowed leg and wheel (the leg lies forward of its pivot), hinged on
# their outer edges; narrow enough to stay on the cone's underside
t_len = (tpiv - twc).length
for side, sg in SIDES:
    s0, s1 = TAIL_PIV_S - t_len - TAIL_R - 0.03, TAIL_PIV_S + 0.05
    skin_door(f'TailDoor_{side}', rect(sg * 0.008, sg * 0.085, s0, s1),
              ((sg * 0.085, s0), (sg * 0.085, s1)), {'gear_door': 80.0})
bpy.context.view_layer.update()

# lights: red and green on the wing tips, white on the tail cone, the landing light on the left leg
tip = at(WING, 5.62)
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    rig.light(f'NavLight_{side}', 'nav', P(tip[1] + 0.35 * tip[2], sg * 5.66, tip[3]), rgb, 'nav', 20.0)
rig.light('NavLight_Tail', 'nav', P(9.82, 0, 0.27), 'FFFFFF', 'nav', 20.0)
rig.landing_light(*mains['L'])

# damage model: a wing goes from the fuselage side out (its leg with it); the tailplane halves outboard of the
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
    if kind == 'wing' and inner >= BODY_W - 1e-3:
        pid = 'wing' + side
    elif kind == 'stab' and inner >= 0.1:
        pid = 'stab' + side
    for q in aircraft_rig.PART_IDS:
        me.attributes['part_' + q].data[poly.index].value = (q == pid)
    if pid:
        counts[pid] = counts.get(pid, 0) + 1
rig.counts = counts
# tip of each part in game coordinates (x right, y up, z aft) and the load that tears it off: 8 g limit x 1.5
# on 4.6 t is 540 kN, of which a wing panel carries ~45%; a tailplane half lets go at 25 kN
wt, st = at(WING, 5.64), at(STAB, 2.08)
rig.breaks({
    'wingR': ((5.64, wt[3] - Z0, wt[1] + 0.5 * wt[2] - Y0), 240e3),
    'wingL': ((-5.64, wt[3] - Z0, wt[1] + 0.5 * wt[2] - Y0), 240e3),
    'stabR': ((2.08, st[3] - Z0, st[1] + 0.5 * st[2] - Y0), 25e3),
    'stabL': ((-2.08, st[3] - Z0, st[1] + 0.5 * st[2] - Y0), 25e3),
})
result = rig.result()
result['tail_ground_z'] = round(tail_ground, 4)
result['legs'] = {k: [round(c, 3) for c in v[2]] for k, v in mains.items()}
result['tail_wheel'] = [round(c, 3) for c in tail[2]]

if _here:
    store_scripts(os.path.join(_here, 'aircraft_rig.py'), os.path.abspath(__file__))
    build = os.path.join(_here, 'p51-build.py')
    if os.path.isfile(build):
        t = bpy.data.texts.get('p51_build.py') or bpy.data.texts.new('p51_build.py')
        t.clear()
        t.write(open(build).read())
if '--save' in sys.argv:
    bpy.ops.wm.save_mainfile()
print('RESULT', result)
