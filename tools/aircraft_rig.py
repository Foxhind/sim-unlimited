"""
Shared rigging for the game's aircraft models (tools/su27-rig.py, tools/f117-rig.py).

A rig script restores the hull from its untouched copy `<hull>_base`, rebuilds everything in its rig
collection and parents it to the hull:
  * <PREFIX>_Controls  an empty whose custom properties are the inputs (pitch, roll, yaw, flaps, speedbrake,
                       gear, nav, beacon, landing) and two derived ones driven from `gear` (DERIVED below);
  * hinged objects: each turns about its own local X axis (the hinge line), rotation_euler.x driven from the
                       controls by angle = clamp(su_bias + sum(gain * signal for signal, gain in su_terms), *su_limits)
                       in degrees, and hidden while `su_show.signal` < `su_show.min`;
  * lights (`su_light`) with energy drivers;
  * the damage model: boolean face attributes `part_<id>` on the hull, `su_part` on hinged objects, and
                       BREAK_<id> empties at each part's tip carrying `max_load` (N).
tools/export-aircraft.py exports this and checks that the drivers in the file compute the same as the game.
Axes: Blender x = the pilot's left, y aft, z up (game: x right, y up, z aft).

Run from a .blend's Text Editor this module is found as the text block `aircraft_rig.py` stored in the file.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

PART_IDS = ['wingL', 'wingR', 'stabL', 'stabR', 'finL', 'finR']
SIDES = (('L', 1.0), ('R', -1.0))  # pilot's left is Blender +x

# inputs of the controls empty: name, default (rest pose), min, max, description
INPUTS = [
    ('pitch', 0.0, -1.0, 1.0, 'Pitch command: +1 full aft stick (nose up)'),
    ('roll', 0.0, -1.0, 1.0, 'Roll command: +1 full right'),
    ('yaw', 0.0, -1.0, 1.0, 'Yaw command: +1 full right pedal'),
    ('flaps', 0.0, 0.0, 1.0, 'Flaps: 1 = landing'),
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
STOW = {'gear_leg': -90.0}       # with bias 90: struts at 90 deg (stowed) .. 0 (down)
GEAR, TYRE, WELL = 'Gear_C9D0D6', 'Tyre_1E1E1E', 'Well_5E7258'


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


def fmt(x):
    return repr(round(float(x), 4))


def angle_expr(terms, bias, lim):
    s = fmt(bias) + ''.join(f' + {fmt(g)} * {n}' for n, g in terms.items())
    return f'radians(clamp({s}, {fmt(lim[0])}, {fmt(lim[1])}))'


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


def vplane(a, b, inside):
    """vertical plane through plan points a, b (Blender xy), normal towards `inside`"""
    d = Vector((b.x - a.x, b.y - a.y, 0))
    n = Vector((-d.y, d.x, 0)).normalized()
    if (inside - a).dot(n) < 0:
        n = -n
    return (Vector((a.x, a.y, 0)), n)


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


class Rig:
    def __init__(self, hull_name, prefix, y0, ground_z, door_mat):
        """y0: Blender y = s - y0 (s = metres aft of the build script's nose datum); ground_z: where the tyres
        touch (the config's gearHeight below the CG); door_mat: outer colour of the gear doors"""
        self.y0 = y0
        self.ground_z = ground_z
        self.made = {}
        hull = self.hull = bpy.data.objects[hull_name]
        cname = f'{prefix} rig'
        coll = self.coll = bpy.data.collections.get(cname)
        if coll:
            for ob in list(coll.objects):
                data = ob.data
                bpy.data.objects.remove(ob)
                if data is not None and data.users == 0:
                    (bpy.data.meshes if isinstance(data, bpy.types.Mesh) else bpy.data.lights).remove(data)
        else:
            coll = self.coll = bpy.data.collections.new(cname)
            (bpy.data.collections.get('Collection') or bpy.context.scene.collection).children.link(coll)
        base = bpy.data.meshes.get(hull_name + '_base')
        if base is None:
            base = hull.data.copy()
            base.name = hull_name + '_base'
            base.use_fake_user = True
        old = hull.data
        hull.data = base.copy()
        bpy.data.meshes.remove(old)
        hull.data.name = hull_name
        hull.matrix_world = Matrix.Identity(4)
        hull['su_airframe'] = 1
        if 'su_part' in hull:
            del hull['su_part']
        hull.animation_data_clear()
        self.hmats = hull.data.materials
        if WELL not in [m.name for m in self.hmats]:
            self.hmats.append(material(WELL))
        self.MI = {m.name: i for i, m in enumerate(self.hmats)}
        self.bvh = BVHTree.FromObject(hull, bpy.context.evaluated_depsgraph_get())
        self.gear_mats = [material(GEAR), material(TYRE), material(WELL), material(door_mat)]

        ctrl = self.ctrl = bpy.data.objects.new(f'{prefix}_Controls', None)
        coll.objects.link(ctrl)
        ctrl.parent = hull
        ctrl.empty_display_type = 'ARROWS'
        ctrl.empty_display_size = 1.0
        ctrl.location = self.P(5.0, 0, 2.0)
        ctrl['su_controls'] = 1
        for name, dflt, lo, hi, desc in INPUTS:
            ctrl[name] = float(dflt)
            ctrl.id_properties_ui(name).update(min=lo, max=hi, soft_min=lo, soft_max=hi, default=dflt, description=desc)
        for name, expr in DERIVED.items():
            ctrl[name] = 0.0
            ctrl.id_properties_ui(name).update(min=0.0, max=1.0, description='derived from gear (driver)')
            d = ctrl.driver_add(f'["{name}"]').driver
            d.type = 'SCRIPTED'
            self.add_vars(d, ['gear'])
            d.expression = expr

        self.hbm = bmesh.new()
        self.hbm.from_mesh(hull.data)

    # ---- geometry helpers -----------------------------------------------------------------------
    def P(self, s, w, z):
        return Vector((w, s - self.y0, z))

    def ray(self, origin, direction):
        hit = self.bvh.ray_cast(Vector(origin), Vector(direction))
        if hit[0] is None:
            raise RuntimeError(f'no hull surface from {origin} along {direction}')
        return hit[0]

    def under(self, x, y):
        return self.ray((x, y, -5.0), (0, 0, 1)).z

    def over(self, x, y):
        return self.ray((x, y, 5.0), (0, 0, -1)).z

    def add_vars(self, drv, names):
        for n in names:
            v = drv.variables.new()
            v.name = n
            v.type = 'SINGLE_PROP'
            v.targets[0].id = self.ctrl
            v.targets[0].data_path = f'["{n}"]'

    # ---- hinged objects -------------------------------------------------------------------------
    def joint(self, name, bm, pivot, axis, up, sample, want, terms, bias=0.0, lim=(-180.0, 180.0),
              parent=None, part=None, show=None, mats=None):
        """bm: geometry in Blender world (rest) coordinates. Positive angle moves `sample` towards `want`."""
        simplify(bm)
        axis = Vector(axis).normalized()
        if axis.cross(Vector(sample) - Vector(pivot)).dot(Vector(want)) < 0:
            axis = -axis
        world = frame(Vector(pivot), axis, Vector(up))
        bmesh.ops.transform(bm, matrix=world.inverted(), verts=bm.verts)
        me = bpy.data.meshes.new(name)
        for m in (mats or self.hmats):
            me.materials.append(m)
        bm.to_mesh(me)
        bm.free()
        for p in me.polygons:
            p.use_smooth = False
        ob = bpy.data.objects.new(name, me)
        self.coll.objects.link(ob)
        par = parent or self.hull
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
        self.add_vars(d, list(terms))
        d.expression = angle_expr(terms, bias, lim)
        if show:
            ob['su_show'] = {'signal': show[0], 'min': float(show[1])}
            for path in ('hide_viewport', 'hide_render'):
                h = ob.driver_add(path).driver
                h.type = 'SCRIPTED'
                self.add_vars(h, [show[0]])
                h.expression = f'{show[0]} < {fmt(show[1])}'
        bpy.context.view_layer.update()
        self.made[name] = ob
        return ob

    def moved_by(self, ob, sample, direction):
        """sign (+1/-1) of a gain that moves `sample` along `direction` when its signal is positive"""
        axis = ob.matrix_world.to_3x3().col[0]
        return 1.0 if axis.cross(Vector(sample) - ob.matrix_world.translation).dot(Vector(direction)) > 0 else -1.0

    # ---- cutting panels out of the hull ---------------------------------------------------------
    def cut(self, region, halfspaces, box):
        """Split the hull faces in `region` that overlap `box` (min, max corners) by every plane,
        return those inside all half-spaces and the box."""
        hbm = self.hbm
        lo, hi = Vector(box[0]) - Vector((0.01,) * 3), Vector(box[1]) + Vector((0.01,) * 3)

        def near(f):
            return all(min(v.co[k] for v in f.verts) <= hi[k] and max(v.co[k] for v in f.verts) >= lo[k] for k in range(3))

        for co, no in halfspaces:
            faces = [f for f in hbm.faces if region(f) and near(f)]
            geom = list({v for f in faces for v in f.verts}) + list({e for f in faces for e in f.edges}) + faces
            bmesh.ops.bisect_plane(hbm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
        # the half-spaces alone are not enough (the Su-27's stabilator, aft of the flaperon hinge and within
        # its span, sits in the wing's region too): a panel is what lies inside its box as well
        inside = [f for f in hbm.faces if region(f)
                  and all(lo[k] <= f.calc_center_median()[k] <= hi[k] for k in range(3))
                  and all((f.calc_center_median() - co).dot(no) > 1e-4 for co, no in halfspaces)]
        stray = [v.co for f in inside for v in f.verts if not all(lo[k] <= v.co[k] <= hi[k] for k in range(3))]
        if stray or not inside:
            raise RuntimeError(f'panel faces outside its box {box}: {stray[:3]}' if stray else f'no faces in box {box}')
        return inside

    def extract(self, faces, keep_copy=None):
        """Move faces out of the hull into a new bmesh (world coordinates)."""
        hbm = self.hbm
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
                hbm.faces.new(vs).material_index = self.MI[WELL]
        bmesh.ops.delete(hbm, geom=faces, context='FACES_ONLY')
        bmesh.ops.delete(hbm, geom=[e for e in hbm.edges if not e.link_faces], context='EDGES')
        bmesh.ops.delete(hbm, geom=[v for v in hbm.verts if not v.link_faces], context='VERTS')
        return nb

    def finish_hull(self):
        simplify(self.hbm)
        self.hbm.normal_update()
        self.hbm.to_mesh(self.hull.data)
        self.hbm.free()
        self.hull.data.update()

    # ---- gear -----------------------------------------------------------------------------------
    def surface_rows(self, sa, sb, wa, wb, depth, n_s=2):
        """points `depth` below the hull underside on a grid from (sa, wa) to (sb, wb): rows along s, [wa, wb] each"""
        pts = []
        for i in range(n_s + 1):
            s = sa + (sb - sa) * i / n_s
            pts.append([self.P(s, w, self.under(w, s - self.y0) - depth) for w in (wa, wb)])
        return pts

    def door(self, name, s0, s1, w_in, w_out, sg, terms):
        """gear door under the hull, hinged on its outer edge (w_out), the inner edge swinging down"""
        rows = self.surface_rows(s0, s1, sg * w_in, sg * w_out, 0.02)
        # the inner (well-coloured) side sits 8 mm above the outer one: coincident faces would flicker
        inner_rows = self.surface_rows(s0, s1, sg * w_in, sg * w_out, 0.012)
        bm = bmesh.new()
        vs_out = [[bm.verts.new(p) for p in row] for row in rows]
        vs_in = [[bm.verts.new(p) for p in row] for row in inner_rows]
        for i in range(len(rows) - 1):
            bm.faces.new((vs_out[i][0], vs_out[i][1], vs_out[i + 1][1], vs_out[i + 1][0])).material_index = 3
            bm.faces.new((vs_in[i + 1][0], vs_in[i + 1][1], vs_in[i][1], vs_in[i][0])).material_index = 2
        hinge0, hinge1 = rows[0][1], rows[-1][1]
        inner = (rows[0][0] + rows[-1][0]) / 2
        return self.joint(name, bm, hinge0, hinge1 - hinge0, Vector((0, 0, 1)), inner, Vector((0, 0, -1)),
                          terms, lim=(0.0, 90.0), mats=self.gear_mats)

    def gear(self, strut_name, wheel_name, s, x, r, width, half, foot, flat=None):
        """a strut at station s, x that swings forward to stow, its wheel touching the ground when down.
        half: half the strut's thickness; foot: how far it reaches below the axle;
        flat: the side ('L'/'R') if the wheel turns flat while the strut stows (Su-27 mains)"""
        piv = self.P(s, x, self.under(x, s - self.y0))
        wc = self.P(s, x, self.ground_z + r)
        bm = bmesh.new()
        prism(bm, piv, wc + Vector((0, 0, -foot)), half, 0)
        strut = self.joint(strut_name, bm, piv, Vector((1, 0, 0)), Vector((0, 0, 1)), wc, Vector((0, -1, 0)),
                           STOW, bias=90.0, lim=(0.0, 90.0), show=('gear_leg', 0.02), mats=self.gear_mats)
        bm = bmesh.new()
        wheel(bm, wc, Vector((1, 0, 0)), r, width, 6, 1, 0)
        if flat:
            sg = 1.0 if flat == 'L' else -1.0
            self.joint(wheel_name, bm, wc, Vector((0, 0, 1)), Vector((0, 1, 0)), wc + Vector((0, -r, 0)), Vector((sg, 0, 0)),
                       STOW, bias=90.0, lim=(0.0, 90.0), parent=strut, show=('gear_leg', 0.02), mats=self.gear_mats)
        else:
            self.joint(wheel_name, bm, wc, Vector((1, 0, 0)), Vector((0, 0, 1)), wc + Vector((0, 0, -r)), Vector((0, 1, 0)),
                       {}, parent=strut, show=('gear_leg', 0.02), mats=self.gear_mats)
        return strut, piv, wc

    # ---- lights ---------------------------------------------------------------------------------
    def light(self, name, kind, pos, rgb, signal, energy, parent=None, blink=None, require=None, spot_dir=None):
        h = int(rgb, 16)
        data = bpy.data.lights.new(name, 'SPOT' if spot_dir else 'POINT')
        data.color = (((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255)
        data.shadow_soft_size = 0.02
        if spot_dir:
            data.spot_size = math.radians(24)
            data.spot_blend = 0.4
        ob = bpy.data.objects.new(name, data)
        self.coll.objects.link(ob)
        ob.parent = parent or self.hull
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
        self.add_vars(d, vars_)
        d.expression = expr
        return ob

    def landing_light(self, strut, piv, wc):
        lp = piv + (wc - piv) * 0.55 + Vector((0, -0.1, 0))
        return self.light('LandingLight', 'landing', lp, 'FFF2D6', 'landing', 400.0, parent=strut, require='gear_leg',
                          spot_dir=Vector((0, -1, -0.12)).normalized())

    # ---- damage model ---------------------------------------------------------------------------
    def paint_parts(self, part_of):
        """part_of(points in game coordinates) -> part id or None, for every hull face"""
        me = self.hull.data
        for pid in PART_IDS:
            me.attributes.get('part_' + pid) or me.attributes.new('part_' + pid, 'BOOLEAN', 'FACE')
        counts = {}
        for poly in me.polygons:
            pid = part_of([(-me.vertices[i].co.x, me.vertices[i].co.z, me.vertices[i].co.y) for i in poly.vertices])
            for q in PART_IDS:
                me.attributes['part_' + q].data[poly.index].value = (q == pid)
            if pid:
                counts[pid] = counts.get(pid, 0) + 1
        self.counts = counts

    def breaks(self, table):
        """table: part id -> ((x, y, z) tip in game coordinates, load that tears it off, N)"""
        for pid, ((gx, gy, gz), load) in table.items():
            e = bpy.data.objects.new(f'BREAK_{pid}', None)
            self.coll.objects.link(e)
            e.parent = self.hull
            e.empty_display_type = 'SPHERE'
            e.empty_display_size = 0.3
            e.location = (-gx, gz, gy)
            e['su_break'] = pid
            e['max_load'] = float(load)
            e.id_properties_ui('max_load').update(description='aerodynamic load on the part that breaks it off, N', min=0.0)

    def result(self):
        bpy.context.view_layer.update()
        me = self.hull.data
        objs = list(self.coll.objects)
        return {
            'hull_tris': sum(len(p.vertices) - 2 for p in me.polygons),
            'objects': sorted(o.name for o in objs),
            'hull_parts': getattr(self, 'counts', {}),
            'rig_tris': sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs if o.type == 'MESH'),
            'simple_exprs': all(fc.driver.is_simple_expression for o in [self.ctrl] + objs
                                for ad in [o.animation_data, getattr(o.data, 'animation_data', None)] if ad
                                for fc in ad.drivers),
        }


def store_scripts(*paths):
    """keep copies of the rig scripts in the .blend, so it can be rerun from its Text Editor"""
    for p in paths:
        name = p.replace('\\', '/').rsplit('/', 1)[-1]
        if name == 'aircraft_rig.py' or name.endswith('-rig.py'):
            t = bpy.data.texts.get(name.replace('-', '_')) or bpy.data.texts.new(name.replace('-', '_'))
            t.clear()
            t.write(open(p).read())
