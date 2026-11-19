"""
Build the low-poly Cessna 150 hull (assets/models/c150.blend) the way an225-build.py builds the An-225's:
one flat-shaded mesh `C150`, materials named <name>_<RRGGBB>, no moving surfaces (tools/c150-rig.py adds those).
Unlike the others it has fixed gear, wing struts and a propeller, all part of the hull.

Run inside Blender (Text Editor > Run Script, the copy stored as `c150_build.py`) or in the background:
  Blender -b --factory-startup --python tools/c150-build.py -- --save assets/models/c150.blend
Axes: Blender x = the pilot's left, y aft, z up; y = s - Y0 (s = metres aft of the spinner tip), z = h - Z0
(h = metres above the thrust line). The origin is the CG.

Real aircraft (C150M): length 7.29 m, span 10.17 m, height 2.59 m (to the beacon on the fin), wing 14.83 m2,
main gear track 1.98 m, wheelbase 1.47 m, propeller 1.75 m (69 in), its tips 0.28 m above the ground.
"""
import bpy, bmesh, math, sys
from mathutils import Vector

NAME = 'C150'
Y0 = 2.2           # CG, metres aft of the spinner tip (about 25% of the root chord)
Z0 = 0.1           # CG above the thrust line
GROUND_H = -1.155  # the ground below the thrust line when standing on its wheels

PAL = {
    'W': ('White', 0xF2F3EF), 'S': ('Shade', 0xD5D9DC), 'R': ('Red', 0xB3202A), 'K': ('Black', 0x17191C),
    'N': ('Glass', 0x1B2B3A), 'M': ('Metal', 0x8A9096), 'D': ('Dark', 0x3A3F44), 'Y': ('Yellow', 0xF2C400),
}
KEYS = list(PAL)

# ---- fuselage ------------------------------------------------------------------------------------
# half cross-section, bottom centre -> top centre: (fraction of the half-breadth, fraction of the half-height)
SECTION = [(0.0, -1.0), (0.7, -0.97), (0.97, -0.72), (1.0, -0.12), (1.0, 0.06), (0.99, 0.28), (0.96, 0.7),
           (0.78, 0.95), (0.0, 1.0)]
# colour of the band between SECTION[i] and SECTION[i + 1]: belly, sides, the cheat line, sides, windows, roof
BANDS = ['S', 'W', 'W', 'R', 'W', 'W', 'W', 'W']
# s, height of the section's centre, half-breadth, half-height
FUSE = [
    (0.0, 0.0, 0.0, 0.0),        # spinner tip
    (0.10, 0.0, 0.11, 0.11),
    (0.22, 0.0, 0.16, 0.16),     # spinner base
    (0.24, 0.0, 0.34, 0.30),     # cowling face
    (0.55, 0.02, 0.45, 0.42),
    (1.35, 0.06, 0.50, 0.50),    # firewall
    (2.00, 0.13, 0.53, 0.68),    # cabin: roof under the wing
    (2.90, 0.15, 0.52, 0.66),
    (3.45, 0.18, 0.45, 0.58),    # behind the rear window
    (4.60, 0.22, 0.30, 0.36),
    (5.90, 0.26, 0.16, 0.17),
    (7.00, 0.30, 0.06, 0.08),
    (7.20, 0.30, 0.0, 0.0),
]
# (segment, band) -> colour, mirrored: red spinner, windshield, door windows, the rear windows
PAINT = {}
for b in range(8):
    PAINT[(0, b)] = PAINT[(1, b)] = 'R'
    PAINT[(2, b)] = 'K' if b in (2, 3, 4) else 'W'   # the cowling's air inlets either side of the spinner
for b in (6, 7):
    PAINT[(5, b)] = 'N'
for b in (5, 6):
    PAINT[(6, b)] = 'N'
for b in (5, 6, 7):
    PAINT[(7, b)] = 'N'

# ---- lifting surfaces ----------------------------------------------------------------------------
# sections: (half-span, s of the leading edge, chord, h of the chord line, thickness/chord); 1 deg dihedral,
# the outer panel tapers to the tip
WING = [
    (0.0, 1.80, 1.63, 0.88, 0.12),
    (2.50, 1.80, 1.63, 0.924, 0.12),
    (5.085, 2.13, 1.18, 0.969, 0.12),
]
STAB = [
    (0.0, 5.95, 0.95, 0.25, 0.09),
    (1.525, 6.28, 0.68, 0.25, 0.08),
]
# the swept fin with its dorsal fillet: (h, s of the leading edge, chord, thickness/chord)
FIN = [(0.30, 5.40, 1.70, 0.08), (0.55, 5.95, 1.15, 0.09), (1.42, 6.62, 0.67, 0.09)]

# ---- gear and propeller --------------------------------------------------------------------------
MAIN_S, MAIN_W, MAIN_R = 2.78, 0.99, 0.21     # station, half-track, tyre radius
NOSE_S, NOSE_R = 1.31, 0.18
PROP_S, PROP_R = 0.25, 0.875
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'strut': 4, 'gear': 5, 'prop': 6}


def lin(c):
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def material(key):
    name, h = PAL[key]
    mn = '%s_%06X' % (name, h)
    m = bpy.data.materials.get(mn) or bpy.data.materials.new(mn)
    rgb = [lin((h >> 16) & 255), lin((h >> 8) & 255), lin(h & 255)]
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


def P(s, w, h):
    return Vector((w, s - Y0, h - Z0))


def build():
    bm = bmesh.new()
    comp = bm.faces.layers.int.new('comp')   # which assembly a face belongs to: the rig script reads it
    cur = [COMP['fuselage']]

    def face(pts, col):
        """pts: counter-clockwise seen from outside; degenerate corners are dropped"""
        vs = []
        for p in pts:
            if not vs or (p - vs[-1]).length > 1e-6:
                vs.append(p)
        if len(vs) > 1 and (vs[0] - vs[-1]).length < 1e-6:
            vs.pop()
        if len(vs) < 3:
            return
        f = bm.faces.new([bm.verts.new(p) for p in vs])
        f.material_index = KEYS.index(col)
        f[comp] = cur[0]

    def loft(rings, cols, flip=False):
        """rings: closed loops of equal length; cols(i, j) -> colour of the quad between rings i, i+1 at j, j+1"""
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            n = len(a)
            for j in range(n):
                k = (j + 1) % n
                q = [a[j], a[k], b[k], b[j]]
                face(list(reversed(q)) if flip else q, cols(i, j))

    # fuselage: full rings from the half section, left side (x > 0) going up, right side coming down
    rings = []
    for s, hc, hw, hh in FUSE:
        left = [P(s, wf * hw, hc + zf * hh) for wf, zf in SECTION]
        right = [P(s, -wf * hw, hc + zf * hh) for wf, zf in reversed(SECTION[1:-1])]
        rings.append(left + right)
    nb = len(BANDS)

    def fuse_col(i, j):
        band = j if j < nb else 2 * nb - 1 - j
        return PAINT.get((i, band), BANDS[band])
    loft(rings, fuse_col, flip=True)

    def airfoil(x, s_le, chord, h, tc, sg, vertical=False):
        """four points: leading edge, upper crest at 30%, trailing edge, lower crest at 30%"""
        t = tc * chord
        pts = [(s_le, 0.1 * t), (s_le + 0.3 * chord, 0.62 * t), (s_le + chord, 0.0), (s_le + 0.3 * chord, -0.38 * t)]
        if vertical:   # x: the fin's station, h: the height of the section, thickness across x
            return [P(pts[0][0], x, h), P(pts[1][0], x + 0.5 * t, h), P(pts[2][0], x, h), P(pts[3][0], x - 0.5 * t, h)]
        return [P(s, sg * x, h + d) for s, d in pts]

    def surface(sections, upper, lower):
        for sg in (1, -1):
            rs = [airfoil(x, s, c, h, tc, sg) for x, s, c, h, tc in sections]
            loft(rs, lambda i, j: upper if j < 2 else lower, flip=(sg == 1))
            tip = rs[-1]
            face(tip if sg == 1 else list(reversed(tip)), upper)

    cur[0] = COMP['wing']
    surface(WING, 'W', 'S')
    cur[0] = COMP['stab']
    surface(STAB, 'W', 'S')

    # the fin on the centre line; a red band near its top
    cur[0] = COMP['fin']
    rs = [airfoil(0.0, s, c, h, tc, 1, vertical=True) for h, s, c, tc in FIN]
    top = FIN[-1]
    band = [(top[0] - 0.22, ), (top[0] - 0.12, )]
    fin_rings = [rs[0], rs[1]]
    for (hb,) in band:   # interpolated sections for the band
        t = (hb - FIN[1][0]) / (FIN[2][0] - FIN[1][0])
        s = FIN[1][1] + (FIN[2][1] - FIN[1][1]) * t
        c = FIN[1][2] + (FIN[2][2] - FIN[1][2]) * t
        fin_rings.append(airfoil(0.0, s, c, hb, 0.09, 1, vertical=True))
    fin_rings.append(rs[2])
    loft(fin_rings, lambda i, j: 'R' if i == 2 else 'W', flip=False)
    face(list(reversed(fin_rings[0])), 'W')
    face(fin_rings[-1], 'W')

    def ring(c, r_w, r_h, n, s_off=0.0):
        """an n-sided ring across the flight direction around c, half-width r_w, half-height r_h"""
        return [c + Vector((r_w * math.cos(2 * math.pi * (k + 0.5) / n), s_off, r_h * math.sin(2 * math.pi * (k + 0.5) / n)))
                for k in range(n)]

    def bar(a, b, hw, ht, col, up=Vector((0, 0, 1))):
        """a flat bar from a to b, half-width hw across it in the plane with `up`, half-thickness ht along `up`"""
        d = (b - a).normalized()
        u = (up - up.dot(d) * d).normalized()
        v = d.cross(u).normalized()
        ra = [a + v * hw + u * ht, a - v * hw + u * ht, a - v * hw - u * ht, a + v * hw - u * ht]
        rb = [p + (b - a) for p in ra]
        for i in range(4):
            j = (i + 1) % 4
            face([ra[i], ra[j], rb[j], rb[i]], col)
        face(list(reversed(ra)), col)
        face(rb, col)

    def wheel(c, r, half_w, col, n=8):
        """a tyre turning about x at c"""
        a = [c + Vector((-half_w, r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n))) for k in range(n)]
        b = [p + Vector((2 * half_w, 0, 0)) for p in a]
        for k in range(n):
            j = (k + 1) % n
            face([a[k], a[j], b[j], b[k]], col)
        face(list(reversed(a)), col)
        face(b, col)

    def pant(c, r, half_w):
        """the wheel fairing: an eight-sided shell around the tyre, open below so the tyre shows"""
        n = 8
        prof = [(-0.42, 0.25, 0.35), (-0.25, 0.85, 0.85), (0.05, 1.0, 1.0), (0.30, 0.8, 0.85), (0.48, 0.2, 0.3)]
        rs = []
        for ds, fw, fh in prof:
            cc = c + Vector((0, ds, 0.05))
            rs.append([cc + Vector((fw * (half_w + 0.05) * math.cos(2 * math.pi * k / n), 0, fh * (r * 0.85) * math.sin(2 * math.pi * k / n)))
                       for k in range(n)])
        loft(rs, lambda i, j: 'R' if j in (1, 2) else 'W', flip=True)
        face(list(reversed(rs[0])), 'W')
        face(rs[-1], 'W')

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    open_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)

    # wing struts: from the lower fuselage to the wing's underside 2.55 m out, double V-section bars
    cur[0] = COMP['strut']
    for sg in (1, -1):
        root = P(2.55, sg * 0.50, -0.30)
        w_le, w_c, w_h = 1.80, 1.63, 0.88 + 2.55 * math.tan(math.radians(1.0))
        tip = P(w_le + 0.30 * w_c, sg * 2.55, w_h - 0.38 * 0.12 * w_c + 0.02)
        bar(root, tip, 0.055, 0.016, 'W', up=Vector((0, -1, 0)))

    # gear: spring-steel main legs, the nose leg under the cowling, tyres in red-striped fairings
    cur[0] = COMP['gear']
    for sg in (1, -1):
        axle = P(MAIN_S, sg * MAIN_W, GROUND_H + MAIN_R)
        bar(P(MAIN_S, sg * 0.48, -0.48), axle + Vector((-sg * 0.12, 0, 0.02)), 0.045, 0.012, 'M', up=Vector((0, 1, 0)))
        wheel(axle, MAIN_R, 0.075, 'K')
        pant(axle, MAIN_R, 0.075)
    nax = P(NOSE_S, 0.0, GROUND_H + NOSE_R)
    bar(P(NOSE_S - 0.05, 0.0, -0.40), nax + Vector((0, 0, 0.12)), 0.035, 0.035, 'M')
    wheel(nax, NOSE_R, 0.06, 'K')
    pant(nax, NOSE_R, 0.06)

    # propeller: two blades, black with yellow tips, set 30 deg off the horizontal and twisted 25 deg to the flow
    cur[0] = COMP['prop']
    hub = P(PROP_S, 0.0, 0.0)
    for k in (0, 1):
        ang = math.radians(30 + 180 * k)
        out = Vector((math.cos(ang), 0, math.sin(ang)))
        side = Vector((0, 1, 0)).cross(out)
        pitch = math.radians(25)
        chord_dir = Vector((0, 1, 0)) * math.sin(pitch) + side * math.cos(pitch)
        for r0, r1, c0, c1, col in ((0.12, 0.78, 0.075, 0.06, 'K'), (0.78, PROP_R, 0.06, 0.045, 'Y')):
            a0, a1 = hub + out * r0, hub + out * r1
            q = [a0 - chord_dir * c0, a1 - chord_dir * c1, a1 + chord_dir * c1, a0 + chord_dir * c0]
            face(q, col)
            face(list(reversed(q)), col)

    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.normal_update()

    me = bpy.data.meshes.get(NAME) or bpy.data.meshes.new(NAME)
    me.clear_geometry()
    me.materials.clear()
    for k in KEYS:
        me.materials.append(material(k))
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = False
    ob = bpy.data.objects.get(NAME)
    if ob is None:
        ob = bpy.data.objects.new(NAME, me)
        (bpy.data.collections.get('Collection') or bpy.context.scene.collection).objects.link(ob)
    ob['ground_z'] = GROUND_H - Z0
    me.update()
    used = {}
    for p in me.polygons:
        k = PAL[KEYS[p.material_index]][0]
        used[k] = used.get(k, 0) + 1
    zs = [v.co.z for v in me.vertices]
    return {'tris': len(me.polygons), 'verts': len(me.vertices), 'by_color': used,
            'dims': [round(v, 3) for v in ob.dimensions], 'open_edges': open_edges,
            'height_over_ground': round(max(zs) - (GROUND_H - Z0), 3), 'lowest': round(min(zs) - (GROUND_H - Z0), 3)}


result = build()
if '--save' in sys.argv:
    path = sys.argv[sys.argv.index('--save') + 1]
    for ob in list(bpy.data.objects):
        if ob.name != NAME:
            bpy.data.objects.remove(ob)
    t = bpy.data.texts.get('c150_build.py') or bpy.data.texts.new('c150_build.py')
    t.clear()
    t.write(open(__file__).read())
    bpy.ops.wm.save_as_mainfile(filepath=path)
print('RESULT', result)
