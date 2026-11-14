"""
Export an aircraft .blend to the game's mesh JSON (src/flight/models/<id>.json).

  Blender -b assets/models/su27.blend --python tools/export-aircraft.py -- su27 src/flight/models/su27.json

Axes: Blender x left (seen from the cockpit), y aft, z up -> game x right, y up, z aft (nose at -z).
Colour: each material is named VGA_<index>_<RRGGBB>; the index picks the VGA ramp.
Parts: a triangle is tagged as a separable part by where its centroid lies (REGIONS below).
"""
import bpy, re, sys, json

PART_IDS = ['wingL', 'wingR', 'stabL', 'stabR', 'finL', 'finR']

# per aircraft: (part name without its side, test on the triangle's three vertices mirrored to the right, x >= 0)
def centroid(v):
    return [sum(p[k] for p in v) / 3 for k in range(3)]

def f117_fin(v):
    x, y, z = centroid(v)
    return y > 0.75 and z > 4.5 and x > 0.6

def f117_wing(v):
    x, y, z = centroid(v)
    return x > 1.9 and y < 0.75

def su27_fin(v):
    # the vertical fins stand at x = 2.1 (the ventral fins below them stay with the fuselage)
    return all(1.95 < p[0] < 2.3 for p in v) and max(p[1] for p in v) > 0.5

def su27_stab(v):
    # the stabilators sit a little below the wing plane (y -0.1 .. -0.3), aft of its trailing edge
    return all(p[0] >= 2.35 and p[1] <= -0.09 for p in v) and centroid(v)[2] > 5.5

def su27_wing(v):
    # outboard of the glove (x = 2.5), in the wing plane
    return all(p[0] >= 2.45 for p in v) and abs(centroid(v)[1]) < 0.3

REGIONS = {
    'f117': [('fin', f117_fin), ('wing', f117_wing)],
    'su27': [('fin', su27_fin), ('stab', su27_stab), ('wing', su27_wing)],
}

argv = sys.argv[sys.argv.index('--') + 1:]
ident, out = argv[0], argv[1]
obj = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
dg = bpy.context.evaluated_depsgraph_get()
me = obj.evaluated_get(dg).to_mesh()
me.calc_loop_triangles()
mw = obj.matrix_world

def game(co):
    w = mw @ co
    return (-w.x, w.z, w.y)

pos, vga, part = [], [], []
for t in me.loop_triangles:
    mat = obj.material_slots[t.material_index].material
    m = re.match(r'VGA_(\d+)_', mat.name if mat else '')
    if not m:
        raise SystemExit(f'material {mat and mat.name!r} is not named VGA_<index>_<hex>')
    pts = [game(me.vertices[i].co) for i in t.vertices]
    cx = centroid(pts)[0]
    right = [(abs(p[0]), p[1], p[2]) for p in pts]
    tag = 0
    for name, test in REGIONS[ident]:
        if test(right):
            tag = PART_IDS.index(name + ('R' if cx > 0 else 'L')) + 1
            break
    for p in pts:
        pos.extend(round(c, 4) for c in p)
    vga.append(int(m.group(1)))
    part.append(tag)

with open(out, 'w') as f:
    json.dump({'source': f'assets/models/{ident}.blend', 'positions': pos, 'vga': vga, 'parts': part}, f, separators=(',', ':'))
print('exported', ident, len(vga), 'triangles', {PART_IDS[i - 1]: part.count(i) for i in set(part) if i})
