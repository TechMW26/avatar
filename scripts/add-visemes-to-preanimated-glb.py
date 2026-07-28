"""Add facial visemes to a pre-animated GLB without changing its body rig.

The input skeleton, skin weights, bind matrices, and embedded animation
actions are imported and exported untouched. Only morph targets on the
existing character mesh are added.

Run with Blender:
  blender --background --python scripts/add-visemes-to-preanimated-glb.py -- \
    <sandipani|rani-laxmi-bai|shivaji-maharaj> <input.glb> <output.glb>
"""

import math
import os
import sys

import bpy
from mathutils import Matrix

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 3:
    raise SystemExit("Expected: <profile> <input.glb> <output.glb>")

profile_name, input_path, output_path = args
input_path = os.path.abspath(input_path)
output_path = os.path.abspath(output_path)

# Coordinates are normalized against the supplied mesh height. These are
# facial regions only; no armature, vertex group, or skin data is modified.
PROFILES = {
    "sandipani": {
        "analysis_yaw_degrees": -45.0,
        "mouth_x": -0.073,
        "mouth_z": 0.8453,
        "mouth_radius_x": 0.0300,
        "mouth_inner_x": 0.0120,
        "top_inner_z": 0.0060,
        "top_outer_z": 0.0220,
        "bottom_inner_z": 0.0120,
        "bottom_outer_z": 0.0350,
        "face_front_y": -0.2000,
        "face_back_y": -0.0800,
        "lower_close": 1.0,
        "upper_close": 0.90,
        "closed_offset": 0.0,
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
    },
    "rani-laxmi-bai": {
        "mouth_z": 0.8832,
        "mouth_radius_x": 0.0226,
        "mouth_inner_x": 0.0100,
        "top_inner_z": 0.0060,
        "top_outer_z": 0.0250,
        "bottom_inner_z": 0.0120,
        "bottom_outer_z": 0.0350,
        "face_front_y": -0.0711,
        "face_back_y": 0.0800,
        "lower_close": 1.0,
        "upper_close": 1.0,
        "closed_offset": 0.0,
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
        # the mouth. Only interpolate along its authored open/closed path.
        "source_open_only": True,
        "source_open_scale": 1.22,
    },
    "shivaji-maharaj": {
        "mouth_z": 0.8379,
        "mouth_radius_x": 0.0300,
        "mouth_inner_x": 0.0120,
        "top_inner_z": 0.0060,
        "top_outer_z": 0.0220,
        "bottom_inner_z": 0.0120,
        "bottom_outer_z": 0.0350,
        "face_front_y": -0.0711,
        "face_back_y": -0.0553,
        "lower_close": 1.0,
        "upper_close": 0.90,
        "closed_offset": 0.0,
        "jaw_angle": 5.0,
        "jaw_front_y": -0.0395,
        "jaw_back_y": -0.0079,
        "jaw_pivot_y": -0.0053,
        "jaw_pivot_z": 0.8500,
        "jaw_inner_x": 0.0526,
        "jaw_outer_x": 0.1000,
        "jaw_bottom_z": 0.7263,
        "jaw_fade_z": 0.7737,
        "source_open_only": True,
        "source_open_scale": 1.22,
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
    if len(obj.data.vertices) > 1_000 and len(obj.vertex_groups) > 0
]
if len(character_meshes) != 1 or len(armatures) != 1:
    raise RuntimeError(
        f"Expected one supplied character mesh and armature, found "
        f"{[(obj.name, len(obj.data.vertices)) for obj in meshes]} and "
        f"{[obj.name for obj in armatures]}"
    )

mesh = character_meshes[0]
armature = armatures[0]
if mesh.data.shape_keys:
    raise RuntimeError("Supplied model already contains facial morph targets")

original_bones = {
    bone.name: tuple(round(value, 8) for row in bone.matrix_local for value in row)
    for bone in armature.data.bones
}
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
    if point.z >= mouth_center_z:
        return 0.0
    # The supplied source meshes have sparse triangles across the chin and
    # cheeks. A broad geometric "jaw" mask catches those triangles and tears
    # the face. Drive only the lower lip ring; the source open-mouth geometry
    # already contains the correct jaw opening.
    lower_lip_weight = smoothstep(
        0.0,
        max(0.0001, scaled("bottom_inner_z") * 0.45),
        mouth_center_z - point.z,
    )
    return mouth_weight(point) * lower_lip_weight


def closed_pose(point, lip_weight, jaw_weight):
    if lip_weight <= 0.0 and jaw_weight <= 0.0:
        return point
    was_lower_lip = point.z < mouth_center_z
    if lip_weight <= 0.0:
        return point
    seam_center = mouth_center_z + scaled("closed_offset")
    seam_gap = 0.0001 * height
    seam = seam_center - seam_gap if was_lower_lip else seam_center + seam_gap
    strength = profile["lower_close"] if was_lower_lip else profile["upper_close"]
    point.z += (seam - point.z) * strength * lip_weight
    point.y += (0.0137 if was_lower_lip else 0.0042) * height * lip_weight
    return point


def make_viseme(horizontal, openness, protrude=0.0, jaw_forward=0.0):
    if profile.get("source_open_only"):
        horizontal = 0.0
        protrude = 0.0
        jaw_forward = 0.0
        openness = min(1.0, openness * profile.get("source_open_scale", 1.0))

    def transform(point, lip_weight, jaw_weight):
        posed = closed_pose(point.copy(), lip_weight, jaw_weight)
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
        if mouth_weight(original) <= 0.000001 and displacement > locality_epsilon:
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
}
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

os.makedirs(os.path.dirname(output_path), exist_ok=True)
for scene_object in list(bpy.context.scene.objects):
    if scene_object not in {mesh, armature}:
        bpy.data.objects.remove(scene_object, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_animations=True,
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
