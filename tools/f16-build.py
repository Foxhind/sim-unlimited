"""
Build the low-poly F-16AM Block 15 MLU hull (assets/models/f16.blend), the version the Ukrainian Air Force flies
(Danish, Dutch, Norwegian and Belgian donor aircraft): one flat-shaded mesh `F-16`, materials named
<name>_<RRGGBB>, no gear or moving surfaces (tools/f16-rig.py adds those on tools/aircraft_rig.py).
The donors' two-tone grey, clean: no stores on the wingtip launch rails or the pylon stations.
The roundels are three concentric octagons cut into the skin, materials Insignia1_ (outer ring), Insignia2_
(middle ring) and Insignia3_ (centre): the game paints them with the national markings chosen in its menu, the
colours here (Ukraine's: blue ring, yellow centre) are what the model shows without a choice.

Run inside Blender (Text Editor > Run Script, the copy stored as `f16_build.py`).
Axes: Blender x = the pilot's left, y aft, z up; y = s - Y0 (s = metres aft of the radome tip), z = h
(h = metres above the wing plane). The origin is the CG.

Real aircraft: length 15.03 m, span 9.45 m over the launch rails, height 5.01 m,
wing 27.87 m2 with 40 deg of leading-edge sweep, single F100-PW-220E.
"""
import bpy, bmesh, math
from mathutils import Vector

NAME = 'F-16'
Y0 = 10.6          # CG, metres aft of the radome tip (about 35% MAC)
GROUND_H = -1.70   # the ground below the wing plane, on its wheels

PAL = {
    'D': ('Gunship', 0x5A6066),   # FS 36118, upper surfaces
    'M': ('Medium', 0x868C90),    # FS 36270, sides and fin
    'L': ('Light', 0xA9AFB2),     # FS 36375, under surfaces
    'R': ('Radome', 0x7A7F82),
    'N': ('Canopy', 0x3A3423),    # gold-tinted canopy
    'K': ('Black', 0x141618),
    'E': ('Nozzle', 0x5F5A55),
    'I1': ('Insignia1', 0x2457B8),   # roundel slots: outer ring, middle ring, centre
    'I2': ('Insignia2', 0xF2C21A),
    'I3': ('Insignia3', 0xF2C21A),
}
KEYS = list(PAL)
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'ventral': 4, 'boom': 5, 'tip': 6, 'canopy': 7, 'nozzle': 8}

# ---- fuselage ------------------------------------------------------------------------------------
# half sections, keel -> top centre: (half-breadth, h) for keel, lower corner, lower side, chine, upper side,
# shoulder, top. Two rings at the intake lip: the step between them is the intake mouth.
FUSE = [
    (0.0, [(0, -0.05)] * 7),
    (0.9, [(0, -0.30), (0.18, -0.27), (0.28, -0.15), (0.32, -0.03), (0.28, 0.10), (0.17, 0.20), (0, 0.24)]),
    (2.0, [(0, -0.42), (0.32, -0.38), (0.48, -0.20), (0.55, 0.0), (0.50, 0.20), (0.32, 0.38), (0, 0.44)]),
    (3.0, [(0, -0.45), (0.38, -0.42), (0.56, -0.22), (0.62, 0.02), (0.56, 0.28), (0.36, 0.48), (0, 0.52)]),
    (4.25, [(0, -0.45), (0.42, -0.42), (0.60, -0.22), (0.66, 0.02), (0.60, 0.30), (0.40, 0.52), (0, 0.56)]),
    (4.25, [(0, -0.80), (0.42, -0.76), (0.55, -0.45), (0.66, 0.02), (0.60, 0.30), (0.40, 0.52), (0, 0.56)]),
    (5.0, [(0, -0.80), (0.45, -0.76), (0.60, -0.45), (0.72, 0.0), (0.64, 0.32), (0.42, 0.55), (0, 0.60)]),
    (6.0, [(0, -0.80), (0.48, -0.76), (0.66, -0.45), (0.78, 0.0), (0.68, 0.34), (0.40, 0.66), (0, 0.80)]),
    (8.0, [(0, -0.78), (0.50, -0.74), (0.72, -0.42), (0.82, 0.0), (0.72, 0.32), (0.40, 0.60), (0, 0.72)]),
    (10.5, [(0, -0.72), (0.52, -0.68), (0.74, -0.38), (0.82, 0.0), (0.74, 0.30), (0.42, 0.54), (0, 0.62)]),
    (12.5, [(0, -0.62), (0.46, -0.56), (0.64, -0.30), (0.70, 0.0), (0.64, 0.26), (0.40, 0.46), (0, 0.52)]),
    (13.9, [(0, -0.55), (0.36, -0.42), (0.50, -0.22), (0.55, 0.0), (0.50, 0.22), (0.36, 0.42), (0, 0.55)]),
]
# colour of each band between the points above, keel to top; (segment, band) overrides
BANDS = ['L', 'L', 'M', 'M', 'D', 'D']
PAINT = {(0, b): 'R' for b in range(6)} | {(1, b): 'R' for b in range(6)} | {(4, b): 'K' for b in range(3)}

# canopy: (s, [(half-breadth, h)] base, side, top)
CANOPY = [
    (2.35, [(0, 0.46)] * 3),
    (3.2, [(0.37, 0.47), (0.30, 0.76), (0, 0.88)]),
    (4.3, [(0.40, 0.50), (0.33, 0.88), (0, 1.02)]),
    (5.3, [(0.40, 0.52), (0.30, 0.82), (0, 0.93)]),
    (6.4, [(0, 0.78)] * 3),
]
NOZZLE = [(13.85, 0.55, 'E'), (14.4, 0.52, 'E'), (14.8, 0.45, None)]

# ---- lifting surfaces: (half-span, s of the leading edge, chord, h of the chord line, thickness/chord) ---
WING = [
    (0.55, 4.3, 8.6, 0.0, 0.02),     # strake root, inside the fuselage
    (0.95, 6.5, 6.4, 0.0, 0.03),
    (1.35, 9.03, 3.87, 0.0, 0.04),   # strake meets the 40 deg leading edge
    (4.57, 11.73, 1.17, 0.0, 0.04),
]
STAB = [
    (0.95, 12.75, 2.2, -0.05, 0.04),
    (2.79, 14.29, 0.72, -0.37, 0.04),  # 10 deg anhedral, span 5.58 m
]
# fin and ventral fins: (h, s of the leading edge, chord, thickness/chord) and their half-breadth
FIN = [(0.3, 10.69, 3.84, 0.05), (3.31, 13.9, 1.05, 0.05)]
VENTRAL = [(-0.50, 11.3, 1.30, 0.06), (-1.08, 11.85, 0.80, 0.06)]
VENTRAL_W = (0.45, 0.60)   # half-breadth at the root and the tip: canted out
# stabilator / airbrake boom beside the nozzle: (s, inner w, outer w, bottom h, top h)
BOOM = [(12.2, 0.62, 0.66, -0.12, 0.10), (12.9, 0.62, 0.95, -0.20, 0.18), (14.95, 0.62, 0.95, -0.20, 0.18)]
# wingtip launch rail
RAIL = (4.57, 4.70, 11.2, 13.0, -0.06, 0.08)
# roundels: (surface, centre s, centre w, radius) on both wings, top and bottom, and the intake sides
ROUNDELS = [('top', 11.55, 3.1, 0.38), ('bottom', 11.55, 3.1, 0.38), ('side', 6.2, 0.0, 0.26)]


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
    return Vector((w, s - Y0, h))


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
        return f

    def loft(rings, cols, flip=False, closed=True):
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            n = len(a)
            for j in range(n if closed else n - 1):
                k = (j + 1) % n
                q = [a[j], a[k], b[k], b[j]]
                face(list(reversed(q)) if flip else q, cols(i, j))

    def ring_of(s, half):
        """full ring from a half section (keel -> top), left side up, right side down"""
        left = [P(s, w, h) for w, h in half]
        right = [P(s, -w, h) for w, h in reversed(half[1:-1])]
        return left + right

    def band_of(j, nb):
        return j if j < nb else 2 * nb - 1 - j

    # fuselage
    rings = [ring_of(s, half) for s, half in FUSE]
    nb = len(FUSE[0][1]) - 1
    loft(rings, lambda i, j: PAINT.get((i, band_of(j, nb)), BANDS[band_of(j, nb)]), flip=True)

    # canopy bubble, its base buried in the fuselage
    cur[0] = COMP['canopy']
    rings = [[P(s, w, h) for w, h in half] + [P(s, -w, h) for w, h in reversed(half[:-1])] for s, half in CANOPY]
    loft(rings, lambda i, j: 'N', flip=True)

    # nozzle and its dark exit
    cur[0] = COMP['nozzle']
    n8 = 8
    rings = [[P(s, r * math.cos(2 * math.pi * (k + 0.5) / n8), r * math.sin(2 * math.pi * (k + 0.5) / n8))
              for k in range(n8)] for s, r, _ in NOZZLE]
    loft(rings, lambda i, j: NOZZLE[i][2], flip=True)
    face(list(reversed(rings[-1])), 'K')

    # stabilator / airbrake booms
    cur[0] = COMP['boom']
    for sg in (1, -1):
        rs = [[P(s, sg * wi, hb), P(s, sg * wo, hb), P(s, sg * wo, ht), P(s, sg * wi, ht)] for s, wi, wo, hb, ht in BOOM]
        loft(rs, lambda i, j: 'L' if j == 0 else 'D' if j == 2 else 'M', flip=(sg == -1))
        face(rs[-1] if sg == 1 else list(reversed(rs[-1])), 'M')

    def airfoil(x, s_le, chord, h, tc, vertical=False):
        """four points: leading edge, upper crest at 30%, trailing edge, lower crest at 30%"""
        t = tc * chord
        if vertical:   # x: the half-breadth, h: the height of the section; thickness across x
            return [P(s_le, x, h), P(s_le + 0.3 * chord, x + 0.5 * t, h), P(s_le + chord, x, h),
                    P(s_le + 0.3 * chord, x - 0.5 * t, h)]
        return [P(s_le, x, h), P(s_le + 0.3 * chord, x, h + 0.5 * t), P(s_le + chord, x, h),
                P(s_le + 0.3 * chord, x, h - 0.5 * t)]

    def surface(sections, upper, lower, root_cap=False):
        for sg in (1, -1):
            rs = [airfoil(sg * x, s, c, h, tc) for x, s, c, h, tc in sections]
            loft(rs, lambda i, j: upper if j < 2 else lower, flip=(sg == 1))
            face(rs[-1] if sg == 1 else list(reversed(rs[-1])), upper)
            if root_cap:
                face(list(reversed(rs[0])) if sg == 1 else rs[0], upper)

    cur[0] = COMP['wing']
    surface(WING, 'D', 'L')
    cur[0] = COMP['stab']
    surface(STAB, 'D', 'L', root_cap=True)

    cur[0] = COMP['fin']
    rs = [airfoil(0.0, s, c, h, tc, vertical=True) for h, s, c, tc in FIN]
    loft(rs, lambda i, j: 'M')
    face(rs[-1], 'M')
    cur[0] = COMP['ventral']
    for sg in (1, -1):
        rs = [airfoil(sg * w, s, c, h, tc, vertical=True) for (h, s, c, tc), w in zip(VENTRAL, VENTRAL_W)]
        loft(rs, lambda i, j: 'L', flip=True)
        face(list(reversed(rs[-1])), 'L')

    # wingtip launch rails
    cur[0] = COMP['tip']
    w0, w1, s0, s1, hb, ht = RAIL
    for sg in (1, -1):
        rs = [[P(s, sg * w0, hb), P(s, sg * w1, hb), P(s, sg * w1, ht), P(s, sg * w0, ht)] for s in (s0, s1)]
        loft(rs, lambda i, j: 'L' if j == 0 else 'D' if j == 2 else 'M', flip=(sg == -1))
        for r_, rev in ((rs[0], sg == 1), (rs[1], sg == -1)):
            face(list(reversed(r_)) if rev else r_, 'M')

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()

    # roundels: cut into the skin with the planes of three octagons, so they lie in it instead of on it
    def roundel(centre, normal, radius, region):
        n = normal.normalized()
        u = (Vector((0, 1, 0)) - Vector((0, 1, 0)).dot(n) * n).normalized()
        v = n.cross(u)

        def overlaps(f, r):
            ds = [x.co - centre for x in f.verts]
            return (min(d.dot(u) for d in ds) < r and max(d.dot(u) for d in ds) > -r and
                    min(d.dot(v) for d in ds) < r and max(d.dot(v) for d in ds) > -r and
                    min(abs(d.dot(n)) for d in ds) < 0.5)
        for r, col in ((radius, 'I1'), (radius * 0.66, 'I2'), (radius * 0.33, 'I3')):
            ap = r * math.cos(math.pi / 8)
            planes = [(math.cos(2 * math.pi * k / 8) * u + math.sin(2 * math.pi * k / 8) * v) for k in range(8)]
            for d in planes:
                faces = [f for f in bm.faces if region(f) and overlaps(f, r)]
                geom = list({x for f in faces for x in f.verts}) + list({e for f in faces for e in f.edges}) + faces
                bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=centre + d * ap, plane_no=d)
            for f in bm.faces:
                if not region(f):
                    continue
                p = f.calc_center_median() - centre
                if all(p.dot(d) < ap - 1e-4 for d in planes):
                    f.material_index = KEYS.index(col)

    for where, s, w, r in ROUNDELS:
        for sg in (1, -1):
            if where == 'side':     # intake side: the vertical faces of the fuselage's lower side band
                region = lambda f, sg=sg: f[comp] == COMP['fuselage'] and f.normal.x * sg > 0.7
                c = P(s, 0, -0.42)
                c.x = sg * 0.62
                roundel(c, Vector((sg, 0, 0)), r, region)
            else:
                up = 1 if where == 'top' else -1
                region = lambda f, sg=sg, up=up: f[comp] == COMP['wing'] and f.normal.z * up > 0.9 and f.calc_center_median().x * sg > 1.5
                roundel(P(s, sg * w, up * 0.06), Vector((0, 0, up)), r, region)

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
    ob['ground_z'] = GROUND_H
    me.update()
    used = {}
    for p in me.polygons:
        k = PAL[KEYS[p.material_index]][0]
        used[k] = used.get(k, 0) + 1
    zs = [v.co.z for v in me.vertices]
    return {'tris': len(me.polygons), 'verts': len(me.vertices), 'by_color': used,
            'dims': [round(v, 2) for v in ob.dimensions], 'height_over_ground': round(max(zs) - GROUND_H, 2)}


result = build()
