"""
Export an aircraft .blend to the game's mesh JSON (src/flight/models/<id>.json).

  Blender -b assets/models/su27.blend --python tools/export-aircraft.py -- su27 src/flight/models/su27.json

Axes: Blender x left (seen from the cockpit), y aft, z up -> game x right, y up, z aft (nose at -z).
Colour: each material's name ends in _<RRGGBB> (e.g. Hull_7D9EFF, or the older VGA_079_7D9EFF);
that colour is the face colour, any RGB.

Rigged models (tools/su27-rig.py) carry everything in the .blend:
  * the airframe is the mesh with the `su_airframe` property; every mesh parented under it is exported too;
  * hinged objects (`su_joint`) turn about their local X axis by
        angle = clamp(su_bias + sum(gain * signal for signal, gain in su_terms), *su_limits)  [deg]
    and are hidden while `su_show.signal` < `su_show.min`. Their rotation_euler.x drivers must compute the
    same: the exporter drives SU27_Controls through sample values and compares, and stops on a mismatch;
  * lights (`su_light`), break points (`su_break` empties with max_load, N);
  * the separable part of a face: `su_part` on the object or an ancestor, else the hull's boolean face
    attribute `part_<id>`.
The rest pose is exported (pitch/roll/yaw/flaps/speedbrake 0, gear 1 = down): every joint is at angle 0.
Models without these (f117.blend) still get their parts from the coordinate rules in REGIONS.
"""
import bpy, re, sys, json, math

PART_IDS = ['wingL', 'wingR', 'stabL', 'stabR', 'finL', 'finR']
# input signals and their rest values; DERIVED must match tools/su27-rig.py and src/flight/articulation.ts
REST = {'pitch': 0.0, 'roll': 0.0, 'yaw': 0.0, 'flaps': 0.0, 'speedbrake': 0.0, 'gear': 1.0,
        'nav': 1.0, 'beacon': 1.0, 'landing': 1.0}
DERIVED = {
    'gear_leg': lambda s: min(1.0, max(0.0, (s['gear'] - 0.2) / 0.6)),
    'gear_door': lambda s: min(1.0, max(0.0, 5.0 * min(s['gear'], 1.0 - s['gear']))),
}
DERIVED_EXPR = {
    'gear_leg': 'clamp((gear - 0.2) / 0.6, 0.0, 1.0)',
    'gear_door': 'clamp(5.0 * min(gear, 1.0 - gear), 0.0, 1.0)',
}


# per aircraft: (part name without its side, test on the triangle's three vertices mirrored to the right, x >= 0)
def centroid(v):
    return [sum(p[k] for p in v) / 3 for k in range(3)]


def f117_fin(v):
    x, y, z = centroid(v)
    return y > 0.75 and z > 4.5 and x > 0.6


def f117_wing(v):
    x, y, z = centroid(v)
    return x > 1.9 and y < 0.75


REGIONS = {
    'f117': [('fin', f117_fin), ('wing', f117_wing)],
}

argv = sys.argv[sys.argv.index('--') + 1:]
ident, out = argv[0], argv[1]
scene = bpy.context.scene
objs = list(scene.objects)
root = next((o for o in objs if o.type == 'MESH' and o.get('su_airframe')), None)
rigged = root is not None
if not rigged:
    root = next(o for o in objs if o.type == 'MESH')
ctrl = next((o for o in objs if o.get('su_controls')), None)


def descendants(o):
    for c in o.children:
        yield c
        yield from descendants(c)


tree = [root] + (list(descendants(root)) if rigged else [])
joints = [o for o in tree if o.get('su_joint')]


def update():
    ctrl.update_tag()
    bpy.context.view_layer.update()
    return bpy.context.evaluated_depsgraph_get()


def signals(inputs):
    s = dict(inputs)
    for k, f in DERIVED.items():
        s[k] = f(s)
    return s


def angle(o, s):
    t = o['su_terms'].to_dict() if hasattr(o['su_terms'], 'to_dict') else dict(o['su_terms'])
    a = o['su_bias'] + sum(g * s[k] for k, g in t.items())
    lo, hi = o['su_limits']
    return min(hi, max(lo, a))


def shown(o, s):
    sh = o.get('su_show')
    return sh is None or s[sh['signal']] >= sh['min']


if rigged:
    if ctrl is None:
        raise SystemExit('rigged airframe without the su_controls empty')
    for k, expr in DERIVED_EXPR.items():
        drv = next((fc.driver for fc in ctrl.animation_data.drivers if fc.data_path == f'["{k}"]'), None)
        if drv is None or drv.expression.replace(' ', '') != expr.replace(' ', ''):
            raise SystemExit(f'{ctrl.name}["{k}"] driver is not {expr!r}: the game would compute it differently')
    # the drivers must do what the game will do: drive the controls through samples and compare
    samples = [dict(REST)]
    for k, vals in (('pitch', (-1, -0.4, 0.7, 1)), ('roll', (-1, 0.5, 1)), ('yaw', (-1, 0.6)), ('flaps', (0.5, 1)),
                    ('speedbrake', (0.3, 1)), ('gear', (0, 0.1, 0.35, 0.5, 0.75, 0.95))):
        for v in vals:
            samples.append({**REST, k: float(v)})
    samples.append({**REST, 'pitch': 1.0, 'roll': 1.0, 'flaps': 1.0})
    for smp in samples:
        for k, v in smp.items():
            ctrl[k] = v
        dg = update()
        s = signals(smp)
        for o in joints:
            e = o.evaluated_get(dg)
            got = math.degrees(e.rotation_euler.x)
            want = angle(o, s)
            if abs(got - want) > 1e-3 or abs(e.rotation_euler.y) > 1e-6 or abs(e.rotation_euler.z) > 1e-6:
                raise SystemExit(f'{o.name}: driver gives {got:.3f} deg at {smp}, su_terms say {want:.3f}')
            if e.hide_viewport == shown(o, s) and o.get('su_show') is not None:
                raise SystemExit(f'{o.name}: hide driver disagrees with su_show at {smp}')
    for k, v in REST.items():
        ctrl[k] = v
    update()
dg = bpy.context.evaluated_depsgraph_get()


def game(v):
    return (-v.x, v.z, v.y)


def r4(t):
    return [round(c, 4) for c in t]


def part_index(name):
    return PART_IDS.index(name) + 1


def own_part(o):
    while o is not None:
        if o.get('su_part'):
            return part_index(o['su_part'])
        o = o.parent
    return 0


def own_joint(o):
    while o is not None:
        if o in joints:
            return joints.index(o) + 1
        o = o.parent
    return 0


pos, rgb, part, joint = [], [], [], []
for o in tree:
    if o.type != 'MESH':
        continue
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    mw = ev.matrix_world
    opart, ojoint = own_part(o), own_joint(o)
    attrs = {p: me.attributes.get('part_' + p) for p in PART_IDS} if rigged else {}
    for t in me.loop_triangles:
        mat = o.material_slots[t.material_index].material
        m = re.search(r'_([0-9A-Fa-f]{6})$', mat.name if mat else '')
        if not m:
            raise SystemExit(f'material {mat and mat.name!r} on {o.name} is not named <name>_<RRGGBB>')
        pts = [game(mw @ me.vertices[i].co) for i in t.vertices]
        tag = opart
        if not tag and rigged:
            hits = [p for p, a in attrs.items() if a is not None and a.data[t.polygon_index].value]
            if len(hits) > 1:
                raise SystemExit(f'{o.name} face {t.polygon_index} is in several parts: {hits}')
            tag = part_index(hits[0]) if hits else 0
        elif not rigged:
            right = [(abs(p[0]), p[1], p[2]) for p in pts]
            cx = centroid(pts)[0]
            for name, test in REGIONS.get(ident, []):
                if test(right):
                    tag = part_index(name + ('R' if cx > 0 else 'L'))
                    break
        for p in pts:
            pos.extend(round(c, 4) for c in p)
        rgb.append(int(m.group(1), 16))
        part.append(tag)
        joint.append(ojoint)
    ev.to_mesh_clear()

model = {'source': f'assets/models/{ident}.blend', 'positions': pos, 'rgb': rgb, 'parts': part}

if rigged:
    jl = []
    for o in joints:
        mw = o.evaluated_get(dg).matrix_world
        ax = mw.to_3x3().col[0].normalized()
        t = dict(o['su_terms'].to_dict() if hasattr(o['su_terms'], 'to_dict') else o['su_terms'])
        j = {'name': o.name, 'pivot': r4(game(mw.translation)), 'axis': r4(game(ax)),
             'parent': own_joint(o.parent), 'terms': {k: round(v, 4) for k, v in t.items()},
             'bias': o['su_bias'], 'limits': list(o['su_limits'])}
        if o.get('su_show') is not None:
            j['show'] = {'signal': o['su_show']['signal'], 'min': o['su_show']['min']}
        jl.append(j)
    lights = []
    for o in tree:
        if not o.get('su_light'):
            continue
        L = {'name': o.name, 'kind': o['su_light'], 'pos': r4(game(o.evaluated_get(dg).matrix_world.translation)),
             'rgb': int(o['su_rgb'], 16), 'signal': o['su_signal'], 'joint': own_joint(o.parent), 'part': own_part(o)}
        if o.get('su_blink') is not None:
            L['blink'] = list(o['su_blink'])
        if o.get('su_require'):
            L['require'] = o['su_require']
        lights.append(L)
    breaks = []
    for o in tree:
        if o.get('su_break'):
            breaks.append({'id': o['su_break'], 'tip': r4(game(o.evaluated_get(dg).matrix_world.translation)),
                           'maxLoad': o['max_load']})
    breaks.sort(key=lambda b: PART_IDS.index(b['id']))
    model.update({'joint': joint, 'joints': jl, 'lights': lights, 'breaks': breaks})

with open(out, 'w') as f:
    json.dump(model, f, separators=(',', ':'))
print('exported', ident, len(rgb), 'triangles', {PART_IDS[i - 1]: part.count(i) for i in set(part) if i},
      (f'{len(model["joints"])} joints, {sum(1 for j in joint if j)} articulated triangles, '
       f'{len(model["lights"])} lights, {len(model["breaks"])} break points') if rigged else '')
