"""
Build the low-poly North American P-51D Mustang hull (assets/models/p51.blend) the way c150-build.py builds the
Cessna's: one flat-shaded mesh `P51`, materials named <name>_<RRGGBB>, no moving surfaces and no gear
(tools/p51-rig.py adds those). The propeller, the radiator scoop under the belly, the bubble canopy and the
exhaust stacks are part of the hull.

Livery: P-51D-5-NA 44-13357 "Tika IV", B7-R of the 361st Fighter Group, from the colour photograph on Wikimedia
Commons (File:P-51-361.jpg): natural metal, the group's yellow spinner and nose band, an olive-drab anti-glare
panel, dark green tips on the wings and the fin, the lower-half invasion stripes of autumn 1944 on the rear
fuselage, the national insignia (blue disc, white star and bars outlined in blue) on both sides of the fuselage,
on top of the left wing and under the right one, and the codes B7 ahead of the fuselage star and R behind it.
The right side reads the same, B7 star R, left to right (B7 aft of the star there) - assumed, no photograph of
that side was found. The markings are cut into the skin with the planes of convex pieces, so they lie in it.
They are fixed colours, not the swappable Insignia slots of the F-16.

Run inside Blender (Text Editor > Run Script, the copy stored as `p51_build.py`) or in the background:
  Blender -b --factory-startup --python tools/p51-build.py -- --save assets/models/p51.blend
Axes: Blender x = the pilot's left, y aft, z up; y = s - Y0 (s = metres aft of the spinner tip), z = h - Z0
(h = metres above the thrust line). The origin is the CG. The model stands level (as in flight, tail up):
the tail wheel touches the ground of the three-point attitude, 10 deg nose up (tools/p51-rig.py).

Real aircraft (P-51D): length 9.83 m, span 11.28 m, height 4.08 m (three-point, a blade vertical), wing 21.65 m2,
5 deg dihedral, main gear track 3.61 m, Hamilton Standard four-blade propeller 3.40 m (11 ft 2 in).
"""
import bpy, bmesh, math, sys
from mathutils import Vector

NAME = 'P51'
Y0 = 3.85          # CG, metres aft of the spinner tip (about 27% of the mean chord)
Z0 = -0.10         # CG below the thrust line
GROUND_H = -1.95   # the ground below the thrust line under the main wheels, standing level (tail up)

PAL = {
    'A': ('Alu', 0xB9BEC2), 'S': ('Shade', 0xA4AAAF), 'O': ('OliveDrab', 0x4B4F2C), 'R': ('Red', 0xB3202A),
    'K': ('Black', 0x17191C), 'N': ('Glass', 0x1B2B3A), 'M': ('Metal', 0x80868C), 'D': ('Dark', 0x2E3236),
    'Y': ('Yellow', 0xF2C400), 'W': ('White', 0xF2F3EF), 'G': ('DarkGreen', 0x2F3B2A),
    'B': ('InsigniaBlue', 0x26335F),
}
KEYS = list(PAL)

# ---- fuselage ------------------------------------------------------------------------------------
# half cross-section, bottom centre -> top centre: (fraction of the half-breadth, fraction of the half-height)
SECTION = [(0.0, -1.0), (0.62, -0.95), (0.93, -0.7), (1.0, -0.25), (1.0, 0.1), (0.97, 0.45), (0.85, 0.75),
           (0.55, 0.95), (0.0, 1.0)]
# colour of the band between SECTION[i] and SECTION[i + 1]: belly, lower sides, sides, upper sides, top
BANDS = ['S', 'S', 'A', 'A', 'A', 'A', 'A', 'A']
# s, height of the section's centre, half-breadth, half-height
FUSE = [
    (0.0, 0.0, 0.0, 0.0),        # spinner tip
    (0.18, 0.0, 0.17, 0.17),
    (0.45, 0.0, 0.27, 0.27),
    (0.74, 0.0, 0.32, 0.32),     # spinner base
    (0.76, -0.04, 0.38, 0.44),   # cowling face
    (1.00, -0.031, 0.398, 0.476),  # the aft edge of the yellow nose band
    (1.30, -0.02, 0.42, 0.52),
    (2.45, 0.0, 0.44, 0.58),     # firewall
    (3.30, -0.04, 0.44, 0.62),   # cockpit
    (4.60, -0.06, 0.41, 0.60),
    (6.00, 0.0, 0.31, 0.50),
    (7.50, 0.12, 0.19, 0.38),
    (8.80, 0.20, 0.09, 0.24),
    (9.60, 0.25, 0.04, 0.10),
    (9.80, 0.26, 0.0, 0.0),
]
# (segment, band) -> colour, mirrored: the yellow spinner and nose band, the olive-drab anti-glare panel
# ahead of the canopy
PAINT = {}
for b in range(8):
    PAINT[(0, b)] = PAINT[(1, b)] = PAINT[(2, b)] = PAINT[(4, b)] = 'Y'
    PAINT[(3, b)] = 'D' if b < 2 else 'Y'     # the cowling face round the spinner; the chin intake below
for i in (5, 6, 7):
    for b in (6, 7):
        PAINT[(i, b)] = 'O'

# ---- lifting surfaces ----------------------------------------------------------------------------
# sections: (half-span, s of the leading edge, chord, h of the chord line, thickness/chord): the laminar wing
# low on the fuselage, 5 deg dihedral from the root, the leading-edge glove inboard, the rounded tip
DIH = math.tan(math.radians(5.0))
WING_H = -0.50
WING = [(w, s, c, WING_H + w * DIH, tc) for w, s, c, tc in (
    (0.0, 2.75, 2.85, 0.15),
    (0.45, 2.78, 2.82, 0.15),
    (1.40, 3.10, 2.42, 0.15),
    (5.40, 3.80, 1.22, 0.11),
    (5.64, 3.97, 0.92, 0.10),
)]
STAB = [
    (0.0, 8.35, 1.35, 0.12, 0.10),
    (2.08, 8.85, 0.72, 0.12, 0.09),
]
# the fin with its dorsal fillet and rounded top: (h, s of the leading edge, chord, thickness/chord)
FIN = [(0.30, 7.00, 2.75, 0.06), (0.45, 7.60, 2.15, 0.08), (0.62, 8.35, 1.42, 0.09), (1.55, 8.75, 0.95, 0.09),
       (1.80, 9.00, 0.62, 0.08)]

# ---- radiator scoop, canopy, propeller -----------------------------------------------------------
# radiator scoop under the belly: (s, top h, bottom h, half-width); the inlet and the exit flap are dark
SCOOP = [(4.35, -0.60, -1.02, 0.30), (5.00, -0.60, -1.07, 0.33), (6.40, -0.40, -1.00, 0.30), (7.30, -0.22, -0.62, 0.17)]
SCOOP_SECTION = [(0.85, 1.0), (1.0, 0.55), (0.95, 0.15), (0.75, 0.0)]   # (fraction of the half-width, of the height above the bottom)
# the bubble canopy: (s, base h, half-width, height above the base); the windscreen, its frame, the bubble
CANOPY = [(3.05, 0.50, 0.30, 0.02), (3.45, 0.50, 0.31, 0.47), (3.50, 0.50, 0.31, 0.48), (3.95, 0.50, 0.32, 0.56),
          (4.55, 0.50, 0.30, 0.48), (5.15, 0.48, 0.10, 0.08)]
CANOPY_SECTION = [(1.0, 0.0), (0.93, 0.45), (0.72, 0.8), (0.38, 0.97), (0.0, 1.0)]
PROP_S, PROP_R, SPINNER_R = 0.42, 1.70, 0.30
PROP_PITCH = 3.0    # m: the blade angle atan(pitch / 2 pi r), within the renderer's +-5% R band at the hub
COMP = {'fuselage': 0, 'wing': 1, 'stab': 2, 'fin': 3, 'scoop': 4, 'canopy': 5, 'prop': 6}
# national insignia: (where, centre s, centre half-span (wings) or h (fuselage), disc radius, sides)
INSIGNIA = [('top', 4.25, 3.9, 0.40, (1,)), ('bottom', 4.25, 3.9, 0.40, (-1,)), ('side', 6.55, 0.05, 0.40, (1, -1))]
# invasion stripes: from s, 18 in (0.457 m) each, on the fuselage and the scoop below h
STRIPES = (5.60, 0.457, 'WKWKW', -0.05)
# codes: (text, s where it starts on the left side, s where it starts on the right side), letters this tall from h
CODES = [('B7', 4.93, 8.17), ('R', 7.50, 5.60)]
CODE_H, CODE_BOTTOM = 0.48, -0.19


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

    def loft(rings, cols, flip=False, closed=True):
        """rings: loops (open strips if not closed) of equal length; cols(i, j) -> colour of the quad
        between rings i, i+1 at j, j+1"""
        for i in range(len(rings) - 1):
            a, b = rings[i], rings[i + 1]
            n = len(a)
            for j in range(n if closed else n - 1):
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
        """four points: leading edge, upper crest at 35%, trailing edge, lower crest at 35% (laminar section)"""
        t = tc * chord
        pts = [(s_le, 0.05 * t), (s_le + 0.35 * chord, 0.55 * t), (s_le + chord, 0.0), (s_le + 0.35 * chord, -0.45 * t)]
        if vertical:   # x: the fin's station, h: the height of the section, thickness across x
            return [P(pts[0][0], x, h), P(pts[1][0], x + 0.5 * t, h), P(pts[2][0], x, h), P(pts[3][0], x - 0.5 * t, h)]
        return [P(s, sg * x, h + d) for s, d in pts]

    def surface(sections, upper, lower, tip_col=None):
        """tip_col: the colour of the outermost segment and the tip face"""
        n = len(sections)
        for sg in (1, -1):
            rs = [airfoil(x, s, c, h, tc, sg) for x, s, c, h, tc in sections]
            loft(rs, lambda i, j: tip_col if tip_col and i == n - 2 else (upper if j < 2 else lower), flip=(sg == 1))
            tip = rs[-1]
            face(tip if sg == 1 else list(reversed(tip)), tip_col or upper)

    cur[0] = COMP['wing']
    surface(WING, 'A', 'S', tip_col='G')
    cur[0] = COMP['stab']
    surface(STAB, 'A', 'S')

    # the fin on the centre line
    cur[0] = COMP['fin']
    fin_rings = [airfoil(0.0, s, c, h, tc, 1, vertical=True) for h, s, c, tc in FIN]
    loft(fin_rings, lambda i, j: 'G' if i == len(FIN) - 2 else 'A', flip=False)   # the dark green tip
    face(list(reversed(fin_rings[0])), 'A')
    face(fin_rings[-1], 'G')

    # radiator scoop: closed rings, the inlet face dark (the splitter gap from the belly reads as its top lip)
    cur[0] = COMP['scoop']
    srings = []
    for s, top, bot, hw in SCOOP:
        left = [P(s, wf * hw, bot + hf * (top - bot)) for wf, hf in SCOOP_SECTION]
        right = [P(s, -wf * hw, bot + hf * (top - bot)) for wf, hf in reversed(SCOOP_SECTION)]
        srings.append(list(reversed(left)) + right)
    loft(srings, lambda i, j: 'S' if j in (3, 4, 5) else 'A', flip=False)
    face(list(reversed(srings[0])), 'K')
    face(srings[-1], 'D')

    # carburettor air intake under the spinner
    cur[0] = COMP['fuselage']
    crings = []
    for s, top, bot, hw in ((0.80, -0.36, -0.55, 0.11), (1.10, -0.40, -0.60, 0.12), (1.60, -0.44, -0.58, 0.10)):
        crings.append([P(s, hw, top), P(s, hw, bot), P(s, -hw, bot), P(s, -hw, top)])
    loft(crings, lambda i, j: 'A', flip=True)
    face(crings[0], 'K')
    face(list(reversed(crings[-1])), 'A')

    # canopy: an open shell standing on the fuselage top; the windscreen, a metal frame, the sliding bubble
    cur[0] = COMP['canopy']
    nrings = []
    for s, base, hw, hh in CANOPY:
        left = [P(s, wf * hw, base + hf * hh) for wf, hf in CANOPY_SECTION]
        right = [P(s, -wf * hw, base + hf * hh) for wf, hf in reversed(CANOPY_SECTION[:-1])]
        nrings.append(left + right)
    loft(nrings, lambda i, j: 'M' if i == 1 else 'N', flip=True, closed=False)
    face(list(reversed(nrings[-1])), 'N')

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

    # six exhaust stacks a side along the cowling, angled back
    cur[0] = COMP['fuselage']
    for sg in (1, -1):
        for k in range(6):
            s = 1.08 + 0.19 * k
            bar(P(s, sg * 0.36, 0.20), P(s + 0.06, sg * 0.47, 0.18), 0.045, 0.03, 'K', up=Vector((0, 1, 0)))

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=[f for f in bm.faces if f[comp] != COMP['canopy']])
    bm.normal_update()

    # ---- markings: convex pieces cut into the skin with the planes of their edges; later pieces paint over
    # earlier ones
    def cut(faces, co, no):
        geom = list({x for f in faces for x in f.verts}) + list({e for f in faces for e in f.edges}) + faces
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
        bm.normal_update()

    def paint(poly, n, region, col):
        """poly: the corners of a convex piece in a plane across n (seen along n onto the skin); region(f):
        the faces it may paint"""
        n = n.normalized()
        c = sum(poly, Vector()) / len(poly)
        edges = []
        for a, b in zip(poly, poly[1:] + poly[:1]):
            d = n.cross(b - a).normalized()
            edges.append((a, d if (c - a).dot(d) > 0 else -d))
        u = (poly[1] - poly[0]).normalized()
        v = n.cross(u)
        box = [(min((p - c).dot(k) for p in poly), max((p - c).dot(k) for p in poly)) for k in (u, v)]

        def near(f):
            ds = [x.co - c for x in f.verts]
            return (region(f) and all(min(d.dot(k) for d in ds) < hi and max(d.dot(k) for d in ds) > lo
                                      for k, (lo, hi) in zip((u, v), box))
                    and min(abs(d.dot(n)) for d in ds) < 0.5)
        for a, d in edges:
            cut([f for f in bm.faces if near(f)], a, d)
        for f in bm.faces:
            if near(f):
                p = f.calc_center_median()
                if all((p - a).dot(d) > 1e-5 for a, d in edges):
                    f.material_index = KEYS.index(col)

    def insignia(c, n, U, V, R, region):
        """the USAAF national insignia (1943 on): a blue disc of radius R with a white five-pointed star, white
        bars R long either side, R/2 wide, the whole outlined R/8 in blue; U along the bars, V to the star's top"""
        pt = lambda x, y: c + U * (x * R) + V * (y * R)
        box = lambda x0, x1, y0, y1: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)]
        o = 0.125
        paint(box(-2 - o, 2 + o, -0.25 - o, 0.25 + o), n, region, 'B')
        paint(box(-2, 2, -0.25, 0.25), n, region, 'W')
        paint([pt(math.cos(2 * math.pi * k / 16), math.sin(2 * math.pi * k / 16)) for k in range(16)], n, region, 'B')
        ri = math.sin(math.radians(18)) / math.sin(math.radians(126))   # the star's inner radius
        outer = [pt(math.cos(math.pi / 2 + 2 * math.pi * k / 5), math.sin(math.pi / 2 + 2 * math.pi * k / 5)) for k in range(5)]
        inner = [pt(ri * math.cos(math.pi * 0.7 + 2 * math.pi * k / 5), ri * math.sin(math.pi * 0.7 + 2 * math.pi * k / 5))
                 for k in range(5)]
        paint(inner, n, region, 'W')
        for k in range(5):
            paint([inner[k - 1], outer[k], inner[k]], n, region, 'W')

    # block letters of stroke pieces in a cell 1 high, W wide (x along the reading direction, y up)
    W, T = 0.62, 0.17
    bar = lambda x0, x1, y0, y1: [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    bowl_top = [(W - T, 0.5), (W, 0.5 + T / 2), (W, 1 - T / 2), (W - T, 1)]
    GLYPHS = {
        'B': [bar(0, T, 0, 1), bar(T, W - T, 1 - T, 1), bar(T, W - T, 0.5 - T / 2, 0.5 + T / 2), bar(T, W - T, 0, T),
              bowl_top, [(W - T, 0), (W, T / 2), (W, 0.5 - T / 2), (W - T, 0.5)]],
        '7': [bar(0, W, 1 - T, 1), [(0.12, 0), (0.12 + 1.1 * T, 0), (W, 1 - T), (W - 1.1 * T, 1 - T)]],
        'R': [bar(0, T, 0, 1), bar(T, W - T, 1 - T, 1), bar(T, W - T, 0.5 - T / 2, 0.5 + T / 2), bowl_top,
              [(0.25, 0.5 - T / 2), (0.25 + 1.1 * T, 0.5 - T / 2), (W, 0), (W - 1.1 * T, 0)]],
    }

    def text(word, s0, sg, region):
        """`word` on the fuselage side sg, read left to right from s0: aft on the left side, forward on the right"""
        U = Vector((0, sg, 0))
        for i, ch in enumerate(word):
            o = P(s0, sg * 0.6, CODE_BOTTOM) + U * (i * (W + 0.15) * CODE_H)
            for piece in GLYPHS[ch]:
                paint([o + U * (x * CODE_H) + Vector((0, 0, y * CODE_H)) for x, y in piece], Vector((sg, 0, 0)), region, 'K')

    # invasion stripes on the lower rear fuselage and the scoop under it
    s0, width, cols, h_top = STRIPES
    low = lambda f: f[comp] in (COMP['fuselage'], COMP['scoop'])
    span = lambda f, a, b: min(x.co.y for x in f.verts) < b - Y0 and max(x.co.y for x in f.verts) > a - Y0
    s1 = s0 + width * len(cols)
    cut([f for f in bm.faces if low(f) and span(f, s0, s1)], P(0, 0, h_top), Vector((0, 0, 1)))
    for k in range(len(cols) + 1):
        cut([f for f in bm.faces if low(f) and span(f, s0, s1)], P(s0 + k * width, 0, 0), Vector((0, 1, 0)))
    for f in bm.faces:
        p = f.calc_center_median()
        if low(f) and p.z < h_top - Z0 and s0 - Y0 < p.y < s1 - Y0:
            f.material_index = KEYS.index(cols[int((p.y + Y0 - s0) / width)])

    for where, s, w, r, sides in INSIGNIA:
        for sg in sides:
            if where == 'side':     # the rear fuselage sides, bars along the fuselage
                region = lambda f, sg=sg: f[comp] == COMP['fuselage'] and f.normal.x * sg > 0.3
                insignia(P(s, sg * 0.6, w), Vector((sg, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1)), r, region)
            else:                   # bars along the span, the star's point to the leading edge
                up = 1 if where == 'top' else -1
                region = lambda f, sg=sg, up=up: (f[comp] == COMP['wing'] and f.normal.z * up > 0.9
                                                  and f.calc_center_median().x * sg > 1.5)
                insignia(P(s, sg * w, WING_H + w * DIH), Vector((0, 0, up)), Vector((1, 0, 0)), Vector((0, -1, 0)), r, region)
    for sg in (1, -1):
        region = lambda f, sg=sg: f[comp] == COMP['fuselage'] and f.normal.x * sg > 0.3
        for word, s_left, s_right in CODES:
            text(word, s_left if sg > 0 else s_right, sg, region)

    open_edges = sum(1 for e in bm.edges if len(e.link_faces) != 2)

    # propeller: four blades, black with yellow tips, twisted from 50 deg at the spinner to the pitch's angle
    cur[0] = COMP['prop']
    hub = P(PROP_S, 0.0, 0.0)
    tip_from = 0.89 * PROP_R
    for k in range(4):
        ang = math.radians(45 + 90 * k)
        out = Vector((math.cos(ang), 0, math.sin(ang)))
        side = Vector((0, 1, 0)).cross(out)

        def chord_dir(r):
            beta = min(math.radians(50), math.atan2(PROP_PITCH, 2 * math.pi * r))
            return Vector((0, 1, 0)) * math.sin(beta) + side * math.cos(beta)
        # (r0, r1, half-chord at r0, at r1, colour): the paddle blade, widest at 1.1 m; every segment reaches past
        # 0.6 R, where the renderer looks for the blades it turns (propeller.ts propVertices)
        for r0, r1, c0, c1, col in ((SPINNER_R - 0.02, 1.10, 0.10, 0.13, 'K'), (1.10, tip_from, 0.13, 0.10, 'K'),
                                    (tip_from, PROP_R, 0.10, 0.06, 'Y')):
            a0, a1 = hub + out * r0, hub + out * r1
            d0, d1 = chord_dir(max(r0, 0.5)), chord_dir(r1)
            q = [a0 - d0 * c0, a1 - d1 * c1, a1 + d1 * c1, a0 + d0 * c0]
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
            'top_over_ground': round(max(zs) - (GROUND_H - Z0), 3), 'lowest': round(min(zs) - (GROUND_H - Z0), 3)}


result = build()
if '--save' in sys.argv:
    path = sys.argv[sys.argv.index('--save') + 1]
    for ob in list(bpy.data.objects):
        if ob.name != NAME:
            bpy.data.objects.remove(ob)
    t = bpy.data.texts.get('p51_build.py') or bpy.data.texts.new('p51_build.py')
    t.clear()
    t.write(open(__file__).read())
    bpy.ops.wm.save_as_mainfile(filepath=path)
print('RESULT', result)
