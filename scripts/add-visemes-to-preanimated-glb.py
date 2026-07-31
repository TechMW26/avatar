"""Add facial visemes without changing the supplied body geometry or rig.

For rigged inputs, the skeleton, skin weights, bind matrices, and embedded
animation actions are imported and exported untouched. Static FBX/GLB skins
are also supported: their original mesh is exported without adding a rig or
body animation. In both cases only morph targets in the facial region change.

Run with Blender:
  blender --background --python scripts/add-visemes-to-preanimated-glb.py -- \
    <sandipani|rani-laxmi-bai|shivaji-maharaj> <input.glb> <output.glb> \
    [material-source.fbx]
"""

import math
import os
import sys

import bpy
from mathutils import Matrix

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) not in (3, 4):
    raise SystemExit(
        "Expected: <profile> <input.glb> <output.glb> [material-source.fbx]"
    )

profile_name, input_path, output_path = args[:3]
material_source_path = args[3] if len(args) == 4 else None
input_path = os.path.abspath(input_path)
output_path = os.path.abspath(output_path)
if material_source_path:
    material_source_path = os.path.abspath(material_source_path)

# Coordinates are normalized against the supplied mesh height. These are
# facial regions only; no armature, vertex group, or skin data is modified.
PROFILES = {
    "sandipani": {
        "analysis_yaw_degrees": 0.0,
        "mouth_x": 0.0,
        "mouth_z": 0.8490,
        "mouth_radius_x": 0.0300,
        "mouth_inner_x": 0.0120,
        "top_inner_z": 0.0060,
        "top_outer_z": 0.0220,
        "bottom_inner_z": 0.0120,
        "bottom_outer_z": 0.0350,
        "face_front_y": -0.1200,
        "face_back_y": -0.0550,
        # Close the authored lower-lip seam in neutral without moving the
        # moustache, upper lip, beard, or jaw.
        "lower_close": 1.05,
        "upper_close": 0.0,
        "lower_forward_close": -0.0060,
        "upper_forward_close": 0.0,
        "closed_offset": 0.0090,
        "jaw_angle": 15.0,
        "jaw_front_y": -0.0737,
        "jaw_back_y": -0.0316,
        "jaw_pivot_y": -0.0132,
        "jaw_pivot_z": 0.8684,
        "jaw_inner_x": 0.0553,
        "jaw_outer_x": 0.0974,
        "jaw_bottom_z": 0.7132,
        "jaw_fade_z": 0.7658,
        "source_open_only": True,
        "source_open_scale": 1.22,
        # This Meshy topology has long facial triangles that connect the
        # mouth to the moustache and beard. Keep those authored surfaces
        # fixed during speech and articulate only the lower lip band.
        "lower_lip_visemes": True,
        "lower_lip_open": 0.0180,
        "lower_lip_center_offset_z": 0.0080,
        "lower_lip_inner_x": 0.0100,
        "lower_lip_outer_x": 0.0250,
        "lower_lip_inner_z": 0.0050,
        "lower_lip_outer_z": 0.0120,
    },
    "rani-laxmi-bai": {
        "mouth_z": 0.8760,
        "mouth_radius_x": 0.0180,
        "mouth_inner_x": 0.0060,
        "top_inner_z": 0.0030,
        "top_outer_z": 0.0100,
        "bottom_inner_z": 0.0040,
        "bottom_outer_z": 0.0140,
        "face_front_y": -0.0550,
        "face_back_y": -0.0250,
        "lower_close": 1.05,
        "upper_close": 0.0,
        "lower_forward_close": -0.0015,
        "upper_forward_close": 0.0,
        "closed_offset": 0.0045,
        "jaw_angle": 0.0,
        "jaw_front_y": -0.0553,
        "jaw_back_y": -0.0211,
        "jaw_pivot_y": -0.0079,
        "jaw_pivot_z": 0.9000,
        "jaw_inner_x": 0.0421,
        "jaw_outer_x": 0.0763,
        "jaw_bottom_z": 0.7816,
        "jaw_fade_z": 0.8211,
        # This lower-density facial topology contains long triangles around
        # the mouth. Keep the upper face fixed and articulate only the
        # authored lower-lip band.
        "source_open_only": True,
        "source_open_scale": 1.12,
    },
    "shivaji-maharaj": {
        "mouth_z": 0.8770,
        "mouth_radius_x": 0.0300,
        "mouth_inner_x": 0.0120,
        "top_inner_z": 0.0060,
        "top_outer_z": 0.0220,
        "bottom_inner_z": 0.0120,
        "bottom_outer_z": 0.0350,
        "face_front_y": -0.0711,
        "face_back_y": -0.0553,
        "lower_close": 1.05,
        "upper_close": 0.0,
        "lower_forward_close": -0.0015,
        "upper_forward_close": 0.0,
        "closed_offset": 0.0045,
        "jaw_angle": 5.0,
        "jaw_front_y": -0.0395,
        "jaw_back_y": -0.0079,
        "jaw_pivot_y": -0.0053,
        "jaw_pivot_z": 0.8500,
        "jaw_inner_x": 0.0526,
        "jaw_outer_x": 0.1000,
        "jaw_bottom_z": 0.7263,
        "jaw_fade_z": 0.7737,
        "jaw_upper_fade_z": 0.8450,
        "coherent_jaw_close": True,
        "rest_jaw_lift": 0.0060,
        "rest_jaw_forward": -0.0010,
        "source_open_only": True,
        "source_open_scale": 1.22,
        # Keep the upper face fixed. Move the connected lower lip, beard and
        # jaw as one soft region so the generated topology does not tear.
        "lower_lip_visemes": True,
        "lower_lip_open": 0.0120,
        "lower_lip_inner_x": 0.0060,
        "lower_lip_outer_x": 0.0220,
        "lower_lip_inner_z": 0.0010,
        "lower_lip_outer_z": 0.0050,
    },
}
if profile_name not in PROFILES:
    raise SystemExit(f"Unknown profile: {profile_name}")


def smoothstep(edge0, edge1, value):
    if edge0 == edge1:
        return 0.0
    factor = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return factor * factor * (3.0 - 2.0 * factor)


bpy.ops.wm.read_factory_settings(use_empty=True)
if input_path.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=input_path)
else:
    bpy.ops.import_scene.gltf(filepath=input_path)

meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
character_meshes = [
    obj
    for obj in meshes
    if len(obj.data.vertices) > 1_000
]
if len(character_meshes) != 1 or len(armatures) > 1:
    raise RuntimeError(
        f"Expected one supplied character mesh and at most one armature, found "
        f"{[(obj.name, len(obj.data.vertices)) for obj in meshes]} and "
        f"{[obj.name for obj in armatures]}"
    )

mesh = character_meshes[0]
armature = armatures[0] if armatures else None
if mesh.data.shape_keys:
    raise RuntimeError("Supplied model already contains facial morph targets")

if material_source_path:
    existing_objects = set(bpy.context.scene.objects)
    bpy.ops.import_scene.fbx(filepath=material_source_path)
    imported_objects = [
        obj for obj in bpy.context.scene.objects if obj not in existing_objects
    ]
    material_meshes = [obj for obj in imported_objects if obj.type == "MESH"]
    if len(material_meshes) != 1:
        raise RuntimeError(
            f"Expected one material-source mesh, found {len(material_meshes)}"
        )
    material_mesh = material_meshes[0]
    if (
        len(material_mesh.data.vertices) != len(mesh.data.vertices)
        or len(material_mesh.data.polygons) != len(mesh.data.polygons)
    ):
        raise RuntimeError(
            "Material source topology does not match the animated mesh"
        )
    source_uv = material_mesh.data.uv_layers.active
    target_uv = mesh.data.uv_layers.active
    if not source_uv or not target_uv or len(source_uv.data) != len(target_uv.data):
        raise RuntimeError(
            "Material source UV layout does not match the animated mesh"
        )
    for index, source_loop in enumerate(source_uv.data):
        target_uv.data[index].uv = source_loop.uv
    if not material_mesh.material_slots or not material_mesh.material_slots[0].material:
        raise RuntimeError("Material source has no usable material")
    mesh.data.materials.clear()
    mesh.data.materials.append(material_mesh.material_slots[0].material)
    for polygon, source_polygon in zip(
        mesh.data.polygons,
        material_mesh.data.polygons,
    ):
        polygon.material_index = source_polygon.material_index
    for imported in imported_objects:
        bpy.data.objects.remove(imported, do_unlink=True)

original_bones = {
    bone.name: tuple(round(value, 8) for row in bone.matrix_local for value in row)
    for bone in armature.data.bones
} if armature else {}
original_vertex_positions = tuple(
    tuple(round(component, 8) for component in vertex.co)
    for vertex in mesh.data.vertices
)
original_weights = tuple(
    tuple(
        sorted(
            (membership.group, round(membership.weight, 8))
            for membership in vertex.groups
        )
    )
    for vertex in mesh.data.vertices
)
original_actions = tuple(sorted(action.name for action in bpy.data.actions))

profile = PROFILES[profile_name]
bpy.context.view_layer.update()
mesh_to_world = mesh.matrix_world.copy()
world_to_mesh = mesh_to_world.inverted_safe()
analysis_rotation = Matrix.Rotation(
    math.radians(profile.get("analysis_yaw_degrees", 0.0)),
    4,
    "Z",
)
analysis_to_world = analysis_rotation.inverted_safe()
points = [
    analysis_rotation @ (mesh_to_world @ vertex.co)
    for vertex in mesh.data.vertices
]
minimum_z = min(point.z for point in points)
maximum_z = max(point.z for point in points)
height = maximum_z - minimum_z
if height <= 0.001:
    raise RuntimeError("Supplied mesh has invalid height")

mouth_center_z = minimum_z + profile["mouth_z"] * height
mouth_center_x = profile.get("mouth_x", 0.0) * height
def scaled(key):
    return profile[key] * height


def mouth_weight(point):
    x_weight = 1.0 - smoothstep(
        scaled("mouth_inner_x"),
        scaled("mouth_radius_x"),
        abs(point.x - mouth_center_x),
    )
    vertical = point.z - mouth_center_z
    if vertical >= 0.0:
        z_weight = 1.0 - smoothstep(
            scaled("top_inner_z"),
            scaled("top_outer_z"),
            vertical,
        )
    else:
        z_weight = 1.0 - smoothstep(
            scaled("bottom_inner_z"),
            scaled("bottom_outer_z"),
            -vertical,
        )
    front_weight = 1.0 - smoothstep(
        scaled("face_front_y"),
        scaled("face_back_y"),
        point.y,
    )
    return max(0.0, x_weight * z_weight * front_weight)


def lower_jaw_weight(point):
    lower_lip_center_z = mouth_center_z + (
        profile.get("lower_lip_center_offset_z", 0.0) * height
    )
    if point.z >= lower_lip_center_z:
        return 0.0
    if profile.get("coherent_jaw_close"):
        x_weight = 1.0 - smoothstep(
            scaled("jaw_inner_x"),
            scaled("jaw_outer_x"),
            abs(point.x - mouth_center_x),
        )
        lower_weight = smoothstep(
            minimum_z + profile["jaw_bottom_z"] * height,
            minimum_z + profile["jaw_fade_z"] * height,
            point.z,
        )
        upper_weight = 1.0 - smoothstep(
            minimum_z + profile["jaw_upper_fade_z"] * height,
            lower_lip_center_z,
            point.z,
        )
        front_weight = 1.0 - smoothstep(
            scaled("jaw_front_y"),
            scaled("jaw_back_y"),
            point.y,
        )
        return max(
            0.0,
            x_weight * lower_weight * upper_weight * front_weight,
        )
    # The supplied source meshes have sparse triangles across the chin and
    # cheeks. A broad geometric "jaw" mask catches those triangles and tears
    # the face. Drive only the lower lip ring; the source open-mouth geometry
    # already contains the correct jaw opening.
    lower_distance = lower_lip_center_z - point.z
    if "lower_lip_outer_z" in profile:
        x_weight = 1.0 - smoothstep(
            scaled("lower_lip_inner_x"),
            scaled("lower_lip_outer_x"),
            abs(point.x - mouth_center_x),
        )
        z_weight = 1.0 - smoothstep(
            scaled("lower_lip_inner_z"),
            scaled("lower_lip_outer_z"),
            lower_distance,
        )
        front_weight = 1.0 - smoothstep(
            scaled("face_front_y"),
            scaled("face_back_y"),
            point.y,
        )
        lower_lip_weight = smoothstep(
            0.0,
            max(0.0001, scaled("lower_lip_inner_z") * 0.45),
            lower_distance,
        )
        return max(
            0.0,
            x_weight * z_weight * front_weight * lower_lip_weight,
        )
    lower_lip_weight = smoothstep(
        0.0,
        max(0.0001, scaled("bottom_inner_z") * 0.45),
        lower_distance,
    )
    return mouth_weight(point) * lower_lip_weight


def closed_pose(point, lip_weight, jaw_weight):
    if lip_weight <= 0.0 and jaw_weight <= 0.0:
        return point
    was_lower_lip = point.z < mouth_center_z
    if profile.get("coherent_jaw_close"):
        point.z += scaled("rest_jaw_lift") * jaw_weight
        point.y += scaled("rest_jaw_forward") * jaw_weight
    if lip_weight <= 0.0:
        return point
    seam_center = mouth_center_z + scaled("closed_offset")
    seam_gap = 0.0001 * height
    seam = seam_center - seam_gap if was_lower_lip else seam_center + seam_gap
    strength = profile["lower_close"] if was_lower_lip else profile["upper_close"]
    point.z += (seam - point.z) * strength * lip_weight
    forward_close = profile.get(
        "lower_forward_close" if was_lower_lip else "upper_forward_close",
        0.0137 if was_lower_lip else 0.0042,
    )
    point.y += forward_close * height * lip_weight
    return point


def make_viseme(horizontal, openness, protrude=0.0, jaw_forward=0.0):
    if profile.get("source_open_only"):
        horizontal = 0.0
        protrude = 0.0
        jaw_forward = 0.0
        openness = min(1.0, openness * profile.get("source_open_scale", 1.0))

    def transform(point, lip_weight, jaw_weight):
        posed = closed_pose(point.copy(), lip_weight, jaw_weight)
        if profile.get("coherent_jaw_close"):
            posed.z += (point.z - posed.z) * openness * lip_weight
            posed.z -= openness * scaled("lower_lip_open") * jaw_weight
            return posed
        if profile.get("lower_lip_visemes"):
            posed.z -= openness * scaled("lower_lip_open") * jaw_weight
            return posed
        posed.z += (point.z - posed.z) * openness
        posed.x += point.x * horizontal * lip_weight
        posed.y -= protrude * height * lip_weight
        posed.y -= jaw_forward * height * jaw_weight
        return posed

    return transform


def set_shape(shape, transform):
    for index, original in enumerate(points):
        shape.data[index].co = world_to_mesh @ (
            analysis_to_world @ transform(
                original.copy(),
                mouth_weight(original),
                lower_jaw_weight(original),
            )
        )


basis = mesh.shape_key_add(name="Basis", from_mix=False)
set_shape(basis, closed_pose)

viseme_pp = mesh.shape_key_add(name="viseme_PP", from_mix=False)
for index, point in enumerate(basis.data):
    viseme_pp.data[index].co = point.co

viseme_transforms = {
    "viseme_aa": make_viseme(-0.02, 0.82, jaw_forward=0.004),
    "viseme_FF": make_viseme(0.02, 0.16),
    "viseme_TH": make_viseme(0.00, 0.30, jaw_forward=0.002),
    "viseme_DD": make_viseme(0.01, 0.32),
    "viseme_kk": make_viseme(0.00, 0.40),
    "viseme_CH": make_viseme(-0.04, 0.34, protrude=0.005),
    "viseme_SS": make_viseme(0.05, 0.20),
    "viseme_nn": make_viseme(0.00, 0.26),
    "viseme_RR": make_viseme(-0.03, 0.40, protrude=0.004),
    "viseme_E": make_viseme(0.10, 0.46, jaw_forward=0.002),
    "viseme_I": make_viseme(0.12, 0.38),
    "viseme_O": make_viseme(-0.12, 0.58, protrude=0.010, jaw_forward=0.004),
    "viseme_U": make_viseme(-0.16, 0.38, protrude=0.013, jaw_forward=0.003),
}
for name, transform in viseme_transforms.items():
    shape = mesh.shape_key_add(name=name, from_mix=False)
    set_shape(shape, transform)

for shape in mesh.data.shape_keys.key_blocks:
    shape.value = 0.0
    shape.slider_min = 0.0
    shape.slider_max = 1.0

# Reject accidental cheek, chin, nose, or full-head deformation. Every
# generated shape must be identical to the supplied mesh outside the soft
# lip mask, and even lip displacement is bounded.
locality_epsilon = height * 0.000001
maximum_lip_displacement = height * 0.065
for shape in mesh.data.shape_keys.key_blocks:
    for index, original in enumerate(points):
        shaped = analysis_rotation @ (mesh_to_world @ shape.data[index].co)
        displacement = (shaped - original).length
        if (
            mouth_weight(original) <= 0.000001
            and lower_jaw_weight(original) <= 0.000001
            and displacement > locality_epsilon
        ):
            raise RuntimeError(
                f"{shape.name} moved non-lip vertex {index} by {displacement}"
            )
        if displacement > maximum_lip_displacement:
            raise RuntimeError(
                f"{shape.name} exceeded safe lip displacement at vertex {index}: "
                f"{displacement}"
            )

current_bones = {
    bone.name: tuple(round(value, 8) for row in bone.matrix_local for value in row)
    for bone in armature.data.bones
} if armature else {}
current_weights = tuple(
    tuple(
        sorted(
            (membership.group, round(membership.weight, 8))
            for membership in vertex.groups
        )
    )
    for vertex in mesh.data.vertices
)
if current_bones != original_bones or current_weights != original_weights:
    raise RuntimeError("Body rig or skin weights changed while adding visemes")
current_vertex_positions = tuple(
    tuple(round(component, 8) for component in vertex.co)
    for vertex in mesh.data.vertices
)
if current_vertex_positions != original_vertex_positions:
    raise RuntimeError("Body base geometry changed while adding visemes")

os.makedirs(os.path.dirname(output_path), exist_ok=True)
for scene_object in list(bpy.context.scene.objects):
    if scene_object not in {mesh, armature}:
        bpy.data.objects.remove(scene_object, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
if armature:
    armature.select_set(True)
bpy.context.view_layer.objects.active = armature or mesh
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_animations=bool(armature and original_actions),
    export_morph=True,
    export_morph_normal=False,
    export_morph_tangent=False,
)

print(
    {
        "profile": profile_name,
        "output": output_path,
        "vertices": len(mesh.data.vertices),
        "bones_preserved": len(original_bones),
        "weights_preserved": current_weights == original_weights,
        "animations_preserved": original_actions,
        "visemes": [shape.name for shape in mesh.data.shape_keys.key_blocks],
    }
)
