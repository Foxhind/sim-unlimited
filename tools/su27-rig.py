"""
Rig the Su-27 model (assets/models/su27.blend) for the game.

Run inside the open Blender (Text Editor > Run Script); it is rerunnable: the hull is first restored
from the untouched mesh kept as `Su-27_base`, and everything in the `SU27 rig` collection is rebuilt.

What it builds, all parented to the hull `Su-27`:
  * SU27_Controls  an empty whose custom properties are the inputs (pitch, roll, yaw, flaps, speedbrake,
                   gear, nav, beacon, landing) and two derived ones driven from `gear` (DERIVED below);
  * hinged panels cut out of the hull: flaperons, leading-edge flaps, all-moving stabilators, rudders and
                   the dorsal airbrake; each turns about its own local X axis (the hinge line), its
                   rotation_euler.x driven from SU27_Controls;
  * retractable gear: nose and main struts, wheels that turn flat as they stow, and sequenced doors;
  * lights: navigation (red left, green right, white tail), two red beacons, landing light on the nose strut;
  * the damage model: boolean face attributes `part_<id>` on the hull (which separable part a face belongs
    to), `su_part` on hinged panels, and BREAK_<id> empties at each part's tip carrying `max_load` (N).

Every articulated object carries the data its driver is built from (su_terms, su_bias, su_limits, su_show);
tools/export-aircraft.py exports those, and checks that the drivers in the file still compute the same thing.
Axes: Blender x = the pilot's left, y aft, z up (game: x right, y up, z aft).
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

Y0 = 11.3                      # su27_build.py: Blender y = s - Y0 (s = metres aft of the nose datum)
HULL, BASE, COLL, CTRL = 'Su-27', 'Su-27_base', 'SU27 rig', 'SU27_Controls'
PART_IDS = ['wingL', 'wingR', 'stabL', 'stabR', 'finL', 'finR']
SIDES = (('L', 1.0), ('R', -1.0))  # pilot's left is Blender +x
GROUND_Z = -2.4                # SU27.gearHeight below the CG (Blender z = 0): where the tyres touch

# inputs of SU27_Controls: name, default (rest pose), min, max, description
INPUTS = [
    ('pitch', 0.0, -1.0, 1.0, 'Pitch command: +1 full aft stick (nose up)'),
    ('roll', 0.0, -1.0, 1.0, 'Roll command: +1 full right'),
    ('yaw', 0.0, -1.0, 1.0, 'Yaw command: +1 full right pedal'),
    ('flaps', 0.0, 0.0, 1.0, 'Flaperons and leading-edge flaps: 1 = landing'),
    ('speedbrake', 0.0, 0.0, 1.0, 'Airbrake: 1 = fully out'),
    ('gear', 1.0, 0.0, 1.0, 'Gear cycle: 1 = down and locked, 0 = up and locked'),
    ('nav', 1.0, 0.0, 1.0, 'Navigation lights'),
    ('beacon', 1.0, 0.0, 1.0, 'Anti-collision beacons'),
    ('landing', 1.0, 0.0, 1.0, 'Landing light (lit only with the nose gear down)'),
]
# derived signals: the same formulas are in src/flight/articulation.ts and tools/export-aircraft.py
DERIVED = {
    'gear_leg': 'clamp((gear - 0.2) / 0.6, 0.0, 1.0)',          # struts: move in the middle of the cycle
    'gear_door': 'clamp(5.0 * min(gear, 1.0 - gear), 0.0, 1.0)',  # doors: open only while the gear travels
}

# colours: <name>_<RRGGBB> (the exporter takes the face colour from the name)
HULL_MAT = {'L': 'VGA_102_B6DBFF', 'M': 'VGA_079_7D9EFF', 'D': 'VGA_150_395571', 'U': 'VGA_078_7DBEFF',
            'W': 'VGA_015_FFFFFF', 'G': 'VGA_125_005571', 'N': 'VGA_020_393939', 'K': 'VGA_017_141414'}
GEAR, TYRE, WELL = 'Gear_C9D0D6', 'Tyre_1E1E1E', 'Well_5E7258'


def P(s, w, z):
    return Vector((w, s - Y0, z))


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    h = int(name[-6:], 16)
    rgb = [lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255)]
    m = bpy.data.materials.new(name)
    m.diffuse_color = rgb + [1.0]
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs[0].default_value = rgb + [1.0]
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    out.location = (220, 0)
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


# ---- start from the untouched hull ---------------------------------------------------------------
hull = bpy.data.objects[HULL]
coll = bpy.data.collections.get(COLL)
if coll:
    for ob in list(coll.objects):
        data = ob.data
        bpy.data.objects.remove(ob)
        if data is not None and data.users == 0:
            (bpy.data.meshes if isinstance(data, bpy.types.Mesh) else bpy.data.lights).remove(data)
else:
    coll = bpy.data.collections.new(COLL)
    (bpy.data.collections.get('Collection') or bpy.context.scene.collection).children.link(coll)
base = bpy.data.meshes.get(BASE)
if base is None:
    base = hull.data.copy()
    base.name = BASE
    base.use_fake_user = True
old = hull.data
hull.data = base.copy()
bpy.data.meshes.remove(old)
hull.data.name = HULL
hull.matrix_world = Matrix.Identity(4)
hull['su_airframe'] = 1
for k in ('su_part',):
    if k in hull:
        del hull[k]
hull.animation_data_clear()
hmats = hull.data.materials
for name in (WELL,):
    if name not in [m.name for m in hmats]:
        hmats.append(material(name))
MI = {m.name: i for i, m in enumerate(hmats)}

dg = bpy.context.evaluated_depsgraph_get()
bvh = BVHTree.FromObject(hull, dg)


def ray(origin, direction):
    hit = bvh.ray_cast(Vector(origin), Vector(direction))
    if hit[0] is None:
        raise RuntimeError(f'no hull surface from {origin} along {direction}')
    return hit[0]


def under(x, y):
    return ray((x, y, -5.0), (0, 0, 1)).z


def over(x, y):
    return ray((x, y, 5.0), (0, 0, -1)).z


# ---- controls -------------------------------------------------------------------------------------
ctrl = bpy.data.objects.new(CTRL, None)
coll.objects.link(ctrl)
ctrl.parent = hull
ctrl.empty_display_type = 'ARROWS'
ctrl.empty_display_size = 1.0
ctrl.location = P(5.0, 0, 2.0)
ctrl['su_controls'] = 1
for name, dflt, lo, hi, desc in INPUTS:
    ctrl[name] = float(dflt)
    ui = ctrl.id_properties_ui(name)
    ui.update(min=lo, max=hi, soft_min=lo, soft_max=hi, default=dflt, description=desc)


def add_vars(drv, names):
    for n in names:
        v = drv.variables.new()
        v.name = n
        v.type = 'SINGLE_PROP'
        v.targets[0].id = ctrl
        v.targets[0].data_path = f'["{n}"]'


for name, expr in DERIVED.items():
    ctrl[name] = 0.0
    ctrl.id_properties_ui(name).update(min=0.0, max=1.0, description='derived from gear (driver)')
    d = ctrl.driver_add(f'["{name}"]').driver
    d.type = 'SCRIPTED'
    add_vars(d, ['gear'])
    d.expression = expr


def fmt(x):
    return repr(round(float(x), 4))


def angle_expr(terms, bias, lim):
    s = fmt(bias) + ''.join(f' + {fmt(g)} * {n}' for n, g in terms.items())
    return f'radians(clamp({s}, {fmt(lim[0])}, {fmt(lim[1])}))'


# ---- hinged objects -------------------------------------------------------------------------------
def frame(pivot, axis, up):
    x = axis.normalized()
    z = (up - up.dot(x) * x).normalized()
    y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = pivot
    return m


def simplify(bm):
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(0.05), use_dissolve_boundaries=False,
                             verts=bm.verts, edges=bm.edges, delimit={'MATERIAL'})


def joint(name, bm, pivot, axis, up, sample, want, terms, bias=0.0, lim=(-180.0, 180.0),
          parent=None, part=None, show=None, mats=None):
    """bm: geometry in Blender world (rest) coordinates. Positive angle moves `sample` towards `want`."""
    simplify(bm)
    axis = Vector(axis).normalized()
    if axis.cross(Vector(sample) - Vector(pivot)).dot(Vector(want)) < 0:
        axis = -axis
    world = frame(Vector(pivot), axis, Vector(up))
    bmesh.ops.transform(bm, matrix=world.inverted(), verts=bm.verts)
    me = bpy.data.meshes.new(name)
    for m in (mats or hmats):
        me.materials.append(m)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    par = parent or hull
    ob.parent = par
    ob.matrix_parent_inverse = Matrix.Identity(4)
    local = par.matrix_world.inverted() @ world
    ob.location = local.translation
    ob.rotation_mode = 'XYZ'
    ob.delta_rotation_euler = local.to_euler('XYZ')
    ob.rotation_euler = (0, 0, 0)
    ob['su_joint'] = 1
    ob['su_terms'] = {k: float(v) for k, v in terms.items()}
    ob['su_bias'] = float(bias)
    ob['su_limits'] = [float(lim[0]), float(lim[1])]
    if part:
        ob['su_part'] = part
    d = ob.driver_add('rotation_euler', 0).driver
    d.type = 'SCRIPTED'
    add_vars(d, list(terms))
    d.expression = angle_expr(terms, bias, lim)
    if show:
        ob['su_show'] = {'signal': show[0], 'min': float(show[1])}
        for path in ('hide_viewport', 'hide_render'):
            h = ob.driver_add(path).driver
            h.type = 'SCRIPTED'
            add_vars(h, [show[0]])
            h.expression = f'{show[0]} < {fmt(show[1])}'
    bpy.context.view_layer.update()
    return ob


# ---- cutting panels out of the hull ---------------------------------------------------------------
hbm = bmesh.new()
hbm.from_mesh(hull.data)


def cut(region, halfspaces, box):
    """Split the hull faces in `region` that overlap `box` (min, max corners) by every plane,
    return those inside all half-spaces."""
    lo, hi = Vector(box[0]) - Vector((0.01,) * 3), Vector(box[1]) + Vector((0.01,) * 3)

    def near(f):
        return all(min(v.co[k] for v in f.verts) <= hi[k] and max(v.co[k] for v in f.verts) >= lo[k] for k in range(3))

    for co, no in halfspaces:
        faces = [f for f in hbm.faces if region(f) and near(f)]
        geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(hbm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
    return [f for f in hbm.faces if region(f)
            and all((f.calc_center_median() - co).dot(no) > 1e-4 for co, no in halfspaces)]


def extract(faces, keep_copy=None):
    """Move faces out of the hull into a new bmesh (world coordinates)."""
    nb = bmesh.new()
    vm = {}
    for f in faces:
        vs = []
        for v in f.verts:
            if v not in vm:
                vm[v] = nb.verts.new(v.co)
            vs.append(vm[v])
        nb.faces.new(vs).material_index = f.material_index
    if keep_copy is not None:      # a recess left behind in the hull, `keep_copy` metres deeper
        vm2 = {}
        for f in faces:
            vs = []
            for v in f.verts:
                if v not in vm2:
                    vm2[v] = hbm.verts.new(v.co + Vector((0, 0, -keep_copy)))
                vs.append(vm2[v])
            hbm.faces.new(vs).material_index = MI[WELL]
    bmesh.ops.delete(hbm, geom=faces, context='FACES_ONLY')
    loose_e = [e for e in hbm.edges if not e.link_faces]
    bmesh.ops.delete(hbm, geom=loose_e, context='EDGES')
    loose_v = [v for v in hbm.verts if not v.link_faces]
    bmesh.ops.delete(hbm, geom=loose_v, context='VERTS')
    return nb


def vplane(a, b, inside):
    """vertical plane through plan points a, b (Blender xy), normal towards `inside`"""
    d = Vector((b.x - a.x, b.y - a.y, 0))
    n = Vector((-d.y, d.x, 0)).normalized()
    if (inside - a).dot(n) < 0:
        n = -n
    return (Vector((a.x, a.y, 0)), n)


def te_s(w):      # wing trailing edge O7 (16.0, 2.5) -> O6 (17.4, 7.0)
    return 16.0 + (w - 2.5) * 1.4 / 4.5


def le_s(w):      # wing leading edge O4 (11.0, 2.5) -> O5 (15.5, 7.0)
    return 11.0 + (w - 2.5)


made = {}
for side, sg in SIDES:
    wing_part = 'wing' + side
    in_wing = lambda f, sg=sg: all(v.co.x * sg >= 2.45 and -0.3 < v.co.z < 0.05 for v in f.verts)

    # flaperon: inboard 2.65 .. 5.6 m, 0.8 .. 0.6 m chord; roll and landing flap
    w0, w1 = 2.65, 5.6
    h0, h1 = P(te_s(w0) - 0.8, sg * w0, 0), P(te_s(w1) - 0.6, sg * w1, 0)
    mid = P(te_s(4.0) - 0.1, sg * 4.0, 0)
    hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
    box = ((min(sg * w0, sg * w1), h0.y, -1), (max(sg * w0, sg * w1), te_s(w1) - Y0, 1))
    bm = extract(cut(in_wing, hs, box))
    made['flaperon' + side] = joint(
        f'Flaperon_{side}', bm, h0, h1 - h0, Vector((0, 0, 1)), mid, Vector((0, 0, -1)),
        {'flaps': 35.0, 'roll': 20.0 * (1 if side == 'L' else -1)}, lim=(-20.0, 35.0), part=wing_part)

    # leading-edge flap: 2.65 .. 6.85 m, 0.5 .. 0.3 m chord
    w0, w1 = 2.65, 6.85
    h0, h1 = P(le_s(w0) + 0.5, sg * w0, 0), P(le_s(w1) + 0.3, sg * w1, 0)
    mid = P(le_s(4.5) + 0.05, sg * 4.5, 0)
    hs = [vplane(h0, h1, mid), (P(0, sg * w0, 0), Vector((sg, 0, 0))), (P(0, sg * w1, 0), Vector((-sg, 0, 0)))]
    box = ((min(sg * w0, sg * w1), le_s(w0) - Y0, -1), (max(sg * w0, sg * w1), h1.y, 1))
    bm = extract(cut(in_wing, hs, box))
    made['lef' + side] = joint(
        f'LEFlap_{side}', bm, h0, h1 - h0, Vector((0, 0, 1)), mid, Vector((0, 0, -1)),
        {'flaps': 30.0}, lim=(0.0, 30.0), part=wing_part)

    # all-moving stabilator: the whole surface, pivot at 45% of the root chord
    in_stab = lambda f, sg=sg: all(v.co.x * sg >= 2.35 and v.co.z <= -0.09 for v in f.verts) \
        and f.calc_center_median().y > 5.5
    faces = [f for f in hbm.faces if in_stab(f)]
    bm = extract(faces)
    root = [e for e in hbm.edges if e.is_boundary and all(v.co.x * sg >= 2.38 and v.co.y > 5.5 and v.co.z < 0.0 for v in e.verts)]
    bmesh.ops.holes_fill(hbm, edges=root, sides=0)
    bm.edges.ensure_lookup_table()
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary and all(v.co.x * sg < 2.55 for v in e.verts)], sides=0)
    piv = P(18.4, sg * 2.45, -0.15)
    made['stab' + side] = joint(
        f'Stabilator_{side}', bm, piv, Vector((1, 0, 0)), Vector((0, 0, 1)), P(19.9, sg * 3.5, -0.1), Vector((0, 0, 1)),
        {'pitch': 25.0, 'roll': 12.0 * (-1 if side == 'L' else 1)}, lim=(-25.0, 25.0), part='stab' + side)

    # rudder: upper two thirds of the fin trailing edge (fins are plates at x = 2.1, built by su27_build.py)
    fin_le = lambda z: 15.2 + z / 3.4 * 2.5
    fin_te = lambda z: 19.0 - z / 3.4 * 0.4
    z0, z1 = 0.9, 3.0
    h0, h1 = P(fin_te(z0) - 0.85, sg * 2.1, z0), P(fin_te(z1) - 0.4, sg * 2.1, z1)
    mid = P(fin_te(2.0) - 0.1, sg * 2.1, 2.0)
    in_fin = lambda f, sg=sg: all(2.05 < v.co.x * sg < 2.15 and v.co.z > -0.05 for v in f.verts)
    hd = (h1 - h0).normalized()
    nh = Vector((1, 0, 0)).cross(hd).normalized()
    if (mid - h0).dot(nh) < 0:
        nh = -nh
    hs = [(h0, nh), (P(0, 0, z0), Vector((0, 0, 1))), (P(0, 0, z1), Vector((0, 0, -1)))]
    box = ((min(sg * 2.0, sg * 2.2), h0.y, z0), (max(sg * 2.0, sg * 2.2), fin_te(z0) - Y0, z1))
    bm = extract(cut(in_fin, hs, box))
    made['rudder' + side] = joint(
        f'Rudder_{side}', bm, h0, h1 - h0, Vector((sg, 0, 0)), mid, Vector((-1, 0, 0)),
        {'yaw': 25.0}, lim=(-25.0, 25.0), part='fin' + side)

# dorsal airbrake behind the canopy: hinged at its front edge, opens 54 deg
in_spine = lambda f: all(v.co.z > 0.25 and abs(v.co.x) < 0.95 and -3.0 < v.co.y < 1.5 for v in f.verts)
hs = [(P(8.9, 0, 0), Vector((0, 1, 0))), (P(11.6, 0, 0), Vector((0, -1, 0))),
      (P(0, 0.6, 0), Vector((-1, 0, 0))), (P(0, -0.6, 0), Vector((1, 0, 0)))]
bm = extract(cut(in_spine, hs, ((-0.6, 8.9 - Y0, 0), (0.6, 11.6 - Y0, 2))), keep_copy=0.12)
made['airbrake'] = joint('Airbrake', bm, P(8.9, 0, over(0, 8.9 - Y0)), Vector((1, 0, 0)), Vector((0, 0, 1)),
                         P(11.6, 0, 0.8), Vector((0, 0, 1)), {'speedbrake': 54.0}, lim=(0.0, 54.0))

bmesh.ops.dissolve_limit(hbm, angle_limit=math.radians(0.05), use_dissolve_boundaries=False,
                         verts=hbm.verts, edges=hbm.edges, delimit={'MATERIAL'})
hbm.normal_update()
hbm.to_mesh(hull.data)
hbm.free()
hull.data.update()


# ---- gear -----------------------------------------------------------------------------------------
def prism(bm, a, b, half, mi):
    """square strut from a to b"""
    d = (b - a).normalized()
    u = d.cross(Vector((1, 0, 0)) if abs(d.x) < 0.9 else Vector((0, 1, 0))).normalized() * half
    v = d.cross(u).normalized() * half
    ring = lambda c: [bm.verts.new(c + u + v), bm.verts.new(c - u + v), bm.verts.new(c - u - v), bm.verts.new(c + u - v)]
    ra, rb = ring(a), ring(b)
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((ra[i], ra[j], rb[j], rb[i])).material_index = mi


def wheel(bm, c, axis, r, width, n, mi_tyre, mi_hub):
    axis = axis.normalized()
    u = axis.cross(Vector((0, 0, 1)) if abs(axis.z) < 0.9 else Vector((0, 1, 0))).normalized()
    v = axis.cross(u)
    rings = []
    for off in (-width / 2, width / 2):
        rings.append([bm.verts.new(c + axis * off + (u * math.cos(2 * math.pi * k / n) + v * math.sin(2 * math.pi * k / n)) * r)
                      for k in range(n)])
    for k in range(n):
        j = (k + 1) % n
        bm.faces.new((rings[0][k], rings[0][j], rings[1][j], rings[1][k])).material_index = mi_tyre
    bm.faces.new(list(reversed(rings[0]))).material_index = mi_hub
    bm.faces.new(rings[1]).material_index = mi_hub


def surface_rows(sa, sb, wa, wb, depth, n_s=2):
    """points `depth` below the hull underside on a grid from (sa, wa) to (sb, wb): rows along s, [wa, wb] each"""
    pts = []
    for i in range(n_s + 1):
        s = sa + (sb - sa) * i / n_s
        row = []
        for w in (wa, wb):
            z = under(w, s - Y0) - depth
            row.append(P(s, w, z))
        pts.append(row)
    return pts


GEAR_MATS = [material(GEAR), material(TYRE), material(WELL), material(HULL_MAT['U'])]
G_STRUT, G_TYRE, G_WELL, G_OUT = 0, 1, 2, 3


def door(name, s0, s1, w_in, w_out, sg, terms):
    rows = surface_rows(s0, s1, sg * w_in, sg * w_out, 0.02)
    bm = bmesh.new()
    vs_out = [[bm.verts.new(p) for p in row] for row in rows]
    vs_in = [[bm.verts.new(p) for p in row] for row in rows]
    for i in range(len(rows) - 1):
        q = (vs_out[i][0], vs_out[i][1], vs_out[i + 1][1], vs_out[i + 1][0])
        bm.faces.new(q).material_index = G_OUT
        bm.faces.new(tuple(reversed((vs_in[i][0], vs_in[i][1], vs_in[i + 1][1], vs_in[i + 1][0])))).material_index = G_WELL
    hinge0, hinge1 = rows[0][1], rows[-1][1]
    inner = (rows[0][0] + rows[-1][0]) / 2
    return joint(name, bm, hinge0, hinge1 - hinge0, Vector((0, 0, 1)), inner, Vector((0, 0, -1)),
                 terms, lim=(0.0, 90.0), mats=GEAR_MATS)


STOW = {'gear_leg': -90.0}       # struts: 90 deg (stowed) .. 0 (down)

# nose gear: single wheel 0.68 m, retracts forward into the fuselage
n_piv = P(7.4, 0, under(0, 7.4 - Y0))
n_r = 0.34
n_wc = P(7.4, 0, GROUND_Z + n_r)
bm = bmesh.new()
prism(bm, n_piv, n_wc + Vector((0, 0, -0.05)), 0.07, G_STRUT)
strut_n = joint('NoseGear', bm, n_piv, Vector((1, 0, 0)), Vector((0, 0, 1)), n_wc, Vector((0, -1, 0)),
                STOW, bias=90.0, lim=(0.0, 90.0), show=('gear_leg', 0.02), mats=GEAR_MATS)
bm = bmesh.new()
wheel(bm, n_wc, Vector((1, 0, 0)), n_r, 0.24, 6, G_TYRE, G_STRUT)
joint('NoseWheel', bm, n_wc, Vector((1, 0, 0)), Vector((0, 0, 1)), n_wc + Vector((0, 0, -n_r)), Vector((0, 1, 0)),
      {}, parent=strut_n, show=('gear_leg', 0.02), mats=GEAR_MATS)
for side, sg in SIDES:
    door(f'NoseDoor_{side}', 6.0, 7.9, 0.03, 0.34, sg, {'gear_door': 85.0})

# main gear: 1.03 m wheels at the real 4.3 m track, retract forward, the wheel turning flat
for side, sg in SIDES:
    x = sg * 2.1
    m_piv = P(13.3, x, under(x, 13.3 - Y0))
    m_r = 0.52
    m_wc = P(13.3, x, GROUND_Z + m_r)
    bm = bmesh.new()
    prism(bm, m_piv, m_wc + Vector((0, 0, -0.08)), 0.09, G_STRUT)
    strut = joint(f'MainGear_{side}', bm, m_piv, Vector((1, 0, 0)), Vector((0, 0, 1)), m_wc, Vector((0, -1, 0)),
                  STOW, bias=90.0, lim=(0.0, 90.0), show=('gear_leg', 0.02), mats=GEAR_MATS)
    bm = bmesh.new()
    wheel(bm, m_wc, Vector((1, 0, 0)), m_r, 0.3, 6, G_TYRE, G_STRUT)
    joint(f'MainWheel_{side}', bm, m_wc, Vector((0, 0, 1)), Vector((0, 1, 0)), m_wc + Vector((0, -m_r, 0)), Vector((sg, 0, 0)),
          STOW, bias=90.0, lim=(0.0, 90.0), parent=strut, show=('gear_leg', 0.02), mats=GEAR_MATS)
    door(f'MainDoor_{side}', 11.2, 13.6, 1.78, 2.35, sg, {'gear_door': 90.0})

bpy.context.view_layer.update()


# ---- lights ---------------------------------------------------------------------------------------
def light(name, kind, pos, rgb, signal, energy, parent=None, blink=None, require=None, spot_dir=None):
    h = int(rgb, 16)
    data = bpy.data.lights.new(name, 'SPOT' if spot_dir else 'POINT')
    data.color = (((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)
    data.shadow_soft_size = 0.02
    if spot_dir:
        data.spot_size = math.radians(24)
        data.spot_blend = 0.4
    ob = bpy.data.objects.new(name, data)
    coll.objects.link(ob)
    ob.parent = parent or hull
    ob.matrix_parent_inverse = Matrix.Identity(4)
    m = Matrix.Translation(pos)
    if spot_dir:
        m = m @ Vector((0, 0, -1)).rotation_difference(spot_dir).to_matrix().to_4x4()
    ob.matrix_world = m
    ob['su_light'] = kind
    ob['su_rgb'] = rgb
    ob['su_signal'] = signal
    ob['su_energy'] = float(energy)
    vars_ = [signal]
    expr = f'{fmt(energy)} * {signal}'
    if blink:
        ob['su_blink'] = [float(b) for b in blink]   # period s, lit s, phase (fraction of the period)
        fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
        expr += f' * (fmod(frame / {fmt(fps)} + {fmt(blink[2] * blink[0])}, {fmt(blink[0])}) < {fmt(blink[1])})'
    if require:
        ob['su_require'] = require          # lit only while this signal is at 1 (>= 0.99)
        vars_.append(require)
        expr += f' * ({require} >= 0.99)'
    d = data.driver_add('energy').driver
    d.type = 'SCRIPTED'
    add_vars(d, vars_)
    d.expression = expr
    return ob


bpy.context.view_layer.update()
for side, sg, rgb in (('L', 1.0, 'FF2A1A'), ('R', -1.0, '22FF55')):
    y = 10.4 - Y0
    hit = ray((sg * 4.0, y, -0.7), (-sg, 0, 0))
    light(f'NavLight_{side}', 'nav', hit + Vector((sg * 0.03, 0, 0)), rgb, 'nav', 20.0)
light('NavLight_Tail', 'nav', P(21.95, 0, 0.0), 'FFFFFF', 'nav', 20.0)
light('Beacon_Top', 'beacon', P(12.4, 0, over(0, 12.4 - Y0) + 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.0))
light('Beacon_Bottom', 'beacon', P(12.6, 0, under(0, 12.6 - Y0) - 0.04), 'FF2200', 'beacon', 60.0, blink=(1.0, 0.12, 0.5))
lp = n_piv + (n_wc - n_piv) * 0.55 + Vector((0, -0.1, 0))
light('LandingLight', 'landing', lp, 'FFF2D6', 'landing', 400.0, parent=strut_n, require='gear_leg',
      spot_dir=Vector((0, -1, -0.12)).normalized())


# ---- damage model -------------------------------------------------------------------------------
# which separable part each hull face belongs to (the rules the exporter used to apply itself)
def g(co):
    return (-co.x, co.z, co.y)


def part_of(pts):
    right = [(abs(p[0]), p[1], p[2]) for p in pts]
    c = [sum(p[k] for p in right) / len(right) for k in range(3)]
    side = 'R' if sum(p[0] for p in pts) > 0 else 'L'
    if all(1.95 < p[0] < 2.3 for p in right) and max(p[1] for p in right) > 0.5:
        return 'fin' + side
    if all(p[0] >= 2.35 and p[1] <= -0.09 for p in right) and c[2] > 5.5:
        return 'stab' + side
    if all(p[0] >= 2.45 for p in right) and abs(c[1]) < 0.3:
        return 'wing' + side
    return None


me = hull.data
for pid in PART_IDS:
    a = me.attributes.get('part_' + pid) or me.attributes.new('part_' + pid, 'BOOLEAN', 'FACE')
counts = {}
for poly in me.polygons:
    pid = part_of([g(me.vertices[i].co) for i in poly.vertices])
    if pid and pid.startswith('stab'):
        pid = None       # the stabilators are separate objects; what is left at their roots is the fuselage
    for q in PART_IDS:
        me.attributes['part_' + q].data[poly.index].value = (q == pid)
    if pid:
        counts[pid] = counts.get(pid, 0) + 1

# break points: tip of each part (the point probed against terrain) and the load that tears it off
BREAKS = {  # game coordinates (x right, y up, z aft), N
    'wingR': ((7.0, 0, 6.1), 960e3), 'wingL': ((-7.0, 0, 6.1), 960e3),
    'stabR': ((4.95, -0.1, 9.2), 330e3), 'stabL': ((-4.95, -0.1, 9.2), 330e3),
    'finR': ((2.1, 3.4, 7.3), 290e3), 'finL': ((-2.1, 3.4, 7.3), 290e3),
}
for pid, ((gx, gy, gz), load) in BREAKS.items():
    e = bpy.data.objects.new(f'BREAK_{pid}', None)
    coll.objects.link(e)
    e.parent = hull
    e.empty_display_type = 'SPHERE'
    e.empty_display_size = 0.3
    e.location = (-gx, gz, gy)
    e['su_break'] = pid
    e['max_load'] = float(load)
    e.id_properties_ui('max_load').update(description='aerodynamic load on the part that breaks it off, N', min=0.0)

bpy.context.view_layer.update()
result = {
    'hull_tris': sum(len(p.vertices) - 2 for p in me.polygons),
    'objects': sorted(o.name for o in coll.objects),
    'hull_parts': counts,
    'rig_tris': sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in coll.objects if o.type == 'MESH'),
    'simple_exprs': all(fc.driver.is_simple_expression for o in [ctrl] + list(coll.objects)
                        for ad in [o.animation_data, getattr(o.data, 'animation_data', None)] if ad
                        for fc in ad.drivers),
}
