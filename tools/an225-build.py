"""
Build the low-poly An-225 hull (assets/models/an225.blend) the way su27_build.py / f117_build.py build theirs:
one flat-shaded mesh `An-225`, materials named <name>_<RRGGBB>, no gear or moving surfaces (a rig script on
tools/aircraft_rig.py adds those).

Run inside Blender (Text Editor > Run Script, the copy stored as `an225_build.py`).
Axes: Blender x = the pilot's left, y aft, z up; y = s - Y0 (s = metres aft of the nose tip), z = h - Z0
(h = metres above the fuselage reference line, the axis of its cylindrical part). The origin is the CG.

Real aircraft: length 84.0 m, span 88.4 m, height 18.1 m (tyres to fin tips), six D-18T.
"""
import bpy, bmesh, math
from mathutils import Vector

NAME = 'An-225'
Y0 = 36.8          # CG, metres aft of the nose tip (about 27% MAC)
Z0 = 1.0           # CG above the fuselage reference line
GROUND_H = -5.5    # the ground below the reference line when standing on its wheels

PAL = {
    'W': ('White', 0xF4F5F2), 'S': ('Shade', 0xD9DDDF), 'B': ('Blue', 0x1F4E9E), 'Y': ('Yellow', 0xF6C700),
    'G': ('Grey', 0xB9BDC1), 'D': ('Dark', 0x4A5057), 'K': ('Black', 0x16181B), 'N': ('Glass', 0x1B2B3A),
    'M': ('Metal', 0x7C8288), 'R': ('Radome', 0x6E7378),
}
KEYS = list(PAL)

# ---- fuselage ------------------------------------------------------------------------------------
# half cross-section, bottom centre -> top centre: (fraction of the half-breadth, fraction of the half-height)
SECTION = [(0.0, -1.0), (0.60, -0.94), (0.94, -0.55), (1.0, -0.14), (1.0, -0.02), (0.985, 0.16),
           (0.82, 0.66), (0.44, 0.94), (0.0, 1.0)]
# colour of the band between SECTION[i] and SECTION[i + 1]
BANDS = ['G', 'W', 'W', 'Y', 'B', 'W', 'W', 'W']
# s, height of the section's centre, half-breadth, half-height
FUSE = [
    (0.0, -1.8, 0.0, 0.0),
    (0.8, -1.65, 1.8, 1.6),
    (2.8, -1.05, 2.9, 2.75),
    (5.8, -0.35, 3.45, 3.6),
    (8.4, -0.02, 3.62, 3.98),
    (12.0, 0.0, 3.65, 4.0),
    (30.0, 0.0, 3.65, 4.0),
    (50.0, 0.0, 3.65, 4.0),
    (56.0, 0.3, 3.5, 3.75),
    (62.0, 1.0, 3.0, 3.2),
    (68.0, 2.2, 2.1, 2.3),
    (74.0, 3.35, 1.15, 1.35),
    (78.6, 3.9, 0.0, 0.0),
]
# (segment, band) -> colour, mirrored: the flight-deck glazing, the grey radome
PAINT = {(3, 6): 'N', (0, 0): 'R', (0, 1): 'R', (0, 2): 'R', (0, 3): 'R', (0, 4): 'R', (0, 5): 'R', (0, 6): 'R', (0, 7): 'R'}

# main-gear fairings on the fuselage sides: s, half-breadth, top h, bottom h
FAIRING = [(28.5, 3.5, -2.2, -3.7), (31.5, 4.9, -1.4, -4.75), (46.5, 4.9, -1.4, -4.75), (50.0, 3.4, -2.2, -3.7)]

# ---- lifting surfaces ----------------------------------------------------------------------------
# sections: (half-span, s of the leading edge, chord, h of the chord line, thickness/chord)
WING = [
    (0.0, 25.4, 18.2, 3.55, 0.137),
    (3.7, 25.4, 18.2, 3.55, 0.137),
    (13.5, 31.2, 12.4, 3.13, 0.125),
    (28.0, 40.6, 8.3, 2.5, 0.105),
    (44.2, 51.1, 3.8, 1.8, 0.09),
]
STAB = [
    (0.0, 67.2, 9.0, 4.6, 0.09),
    (16.33, 74.4, 6.6, 6.3, 0.085),
]
# each fin, on the tailplane tip and leaning in with its dihedral: (h, s of the leading edge, chord, thickness/chord)
FIN_X, FIN_H, FIN_CANT = 16.33, 6.3, 7.0
FIN = [(4.0, 74.9, 7.5, 0.07), (6.3, 74.0, 9.0, 0.075), (12.6, 80.3, 3.7, 0.075)]

# ---- engines -------------------------------------------------------------------------------------
# (half-span, s of the intake lip, h of the axis)
ENGINES = [(11.5, 24.2, 0.3), (18.9, 28.9, 0.0), (26.5, 33.8, -0.3)]
# nacelle rings: (metres aft of the lip, radius, colour of the skin aft of the ring)
NACELLE = [(0.0, 1.25, 'W'), (1.0, 1.5, 'W'), (3.7, 1.42, 'M'), (3.85, 1.0, 'M'), (5.8, 0.65, 'D'), (6.8, 0.2, None)]
NSIDES = 8
COMP = {'fuselage': 0, 'fairing': 1, 'wing': 2, 'stab': 3, 'fin': 4, 'nacelle': 5, 'pylon': 6}


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
    n = len(SECTION)
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

    # gear fairings: a chamfered box on each side, open towards the fuselage
    cur[0] = COMP['fairing']
    for sg in (1, -1):
        rs = []
        for k, (s, w, top, bot) in enumerate(FAIRING):
            ch = 0.45 if 0 < k < len(FAIRING) - 1 else 0.2
            ring = [P(s, sg * 2.2, top), P(s, sg * (w - ch), top), P(s, sg * w, top - ch),
                    P(s, sg * w, bot + ch), P(s, sg * (w - ch), bot), P(s, 0.0, bot)]
            rs.append(ring)
        loft(rs, lambda i, j: 'G' if j >= 3 else 'W', flip=(sg == -1))

    def airfoil(x, s_le, chord, h, tc, sg, vertical=False):
        """four points: leading edge, upper crest at 30%, trailing edge, lower crest at 30%"""
        t = tc * chord
        pts = [(s_le, 0.1 * t), (s_le + 0.3 * chord, 0.62 * t), (s_le + chord, 0.0), (s_le + 0.3 * chord, -0.38 * t)]
        if vertical:   # x: the fin's station, h: the height of the section, thickness across x
            return [P(pts[0][0], x, h), P(pts[1][0], x + 0.5 * t, h), P(pts[2][0], x, h), P(pts[3][0], x - 0.5 * t, h)]
        return [P(s, sg * x, h + d) for s, d in pts]

    def surface(sections, upper, lower, cap=True):
        for sg in (1, -1):
            rs = [airfoil(x, s, c, h, tc, sg) for x, s, c, h, tc in sections]
            loft(rs, lambda i, j: upper if j < 2 else lower, flip=(sg == 1))
            if cap:
                tip = rs[-1]
                face(tip if sg == 1 else list(reversed(tip)), upper)

    cur[0] = COMP['wing']
    surface(WING, 'W', 'S')
    cur[0] = COMP['stab']
    surface(STAB, 'W', 'S', cap=False)   # the tips end inside the fins
    cur[0] = COMP['fin']

    # twin fins on the tailplane tips, standing above and below it
    for sg in (1, -1):
        rs = [airfoil(sg * (FIN_X - (h - FIN_H) * math.tan(math.radians(FIN_CANT))), s, c, h, tc, 1, vertical=True)
              for h, s, c, tc in FIN]
        loft(rs, lambda i, j: 'W', flip=False)
        face(list(reversed(rs[0])), 'W')
        face(rs[-1], 'W')

    # engines: nacelle, intake and nozzle discs, pylon
    def wing_at(x):
        for a, b in zip(WING, WING[1:]):
            if a[0] <= x <= b[0]:
                t = (x - a[0]) / (b[0] - a[0])
                return [a[k] + (b[k] - a[k]) * t for k in range(5)]

    cur[0] = COMP['nacelle']
    for sg in (1, -1):
        for x, s0, h in ENGINES:
            rs = []
            for ds, r, _ in NACELLE:
                rs.append([P(s0 + ds, sg * x + r * math.cos(2 * math.pi * (k + 0.5) / NSIDES),
                             h + r * math.sin(2 * math.pi * (k + 0.5) / NSIDES)) for k in range(NSIDES)])
            loft(rs, lambda i, j: NACELLE[i][2], flip=True)
            face(rs[0], 'K')
            face(list(reversed(rs[-1])), 'K')

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    open_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)

    cur[0] = COMP['pylon']
    # pylons: a double-sided plate from the top of each nacelle to the wing's underside
    for sg in (1, -1):
        for x, s0, h in ENGINES:
            _, w_le, w_c, w_h, w_tc = wing_at(x)
            under = w_h - 0.3 * w_tc * w_c
            plate = [P(s0 + 1.4, sg * x, h + 1.4), P(s0 + 5.6, sg * x, h + 0.7),
                     P(w_le + 0.42 * w_c, sg * x, under), P(w_le + 0.04 * w_c, sg * x, w_h)]
            face(plate, 'W')
            face(list(reversed(plate)), 'W')

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
            'dims': [round(v, 2) for v in ob.dimensions], 'open_edges': open_edges,
            'height_over_ground': round(max(zs) - (GROUND_H - Z0), 2), 'ground_z': round(GROUND_H - Z0, 2)}


result = build()
