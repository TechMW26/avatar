"""Rig a Meshy humanoid and add closed-mouth Oculus visemes.

The source must be a clean, centered humanoid T-pose. Skin weights are
transferred from the kiosk's Mixamo reference character, normalized, and
limited to four influences per vertex for glTF/WebGL compatibility.

Run with Blender:
  blender --background --python scripts/prepare-meshy-character.py -- \
    <sandipani|rani-laxmi-bai|shivaji-maharaj> \
    <source.glb> <output.glb> [reference.fbx]
"""

import math
import os
import statistics
import sys

import bmesh
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) not in (3, 4):
    raise SystemExit(
        "Expected: <profile> <source.glb> <output.glb> [reference.fbx]"
    )

profile_name, source_path, output_path = args[:3]
reference_path = args[3] if len(args) == 4 else "public/avatar.fbx"
source_path = os.path.abspath(source_path)
output_path = os.path.abspath(output_path)
reference_path = os.path.abspath(reference_path)

PROFILES = {
    "sandipani": {
        "object_name": "RishiSandipani",
        "mouth_center_z": 0.656,
        "mouth_radius_x": 0.072,
        "mouth_inner_x": 0.034,
        "mouth_top_inner_z": 0.020,
        "mouth_top_outer_z": 0.068,
        "mouth_bottom_inner_z": 0.040,
        "mouth_bottom_outer_z": 0.095,
        "face_front_y": -0.185,
        "face_back_y": 0.045,
        "lower_lip_close_strength": 0.78,
        "upper_lip_close_strength": 0.0,
        "closed_target_offset": 0.018,
        "closed_seam": 0.0002,
        "rest_jaw_close_degrees": 15.0,
        "rest_jaw_lift": 0.0,
        "rest_jaw_retract": 0.0,
        "jaw_front_y": -0.140,
        "jaw_back_y": -0.060,
        "jaw_pivot_y": -0.025,
        "jaw_pivot_z": 0.700,
        "jaw_radius_inner_x": 0.105,
        "jaw_radius_outer_x": 0.185,
        "jaw_bottom_z": 0.405,
        "jaw_lower_fade_z": 0.505,
        "shoulder_weight_radius": 0.32,
    },
    "rani-laxmi-bai": {
        "object_name": "RaniLaxmiBai",
        "mouth_center_z": 0.728,
        "mouth_radius_x": 0.043,
        "mouth_inner_x": 0.032,
        "mouth_top_inner_z": 0.012,
        "mouth_top_outer_z": 0.043,
        "mouth_bottom_inner_z": 0.030,
        "mouth_bottom_outer_z": 0.065,
        "face_front_y": -0.135,
        "face_back_y": 0.025,
        "lower_lip_close_strength": 0.80,
        "upper_lip_close_strength": 0.80,
        "closed_target_offset": 0.0,
        "closed_seam": 0.0002,
        "rest_jaw_close_degrees": 0.0,
        "rest_jaw_lift": 0.0,
        "rest_jaw_retract": 0.0,
        "jaw_front_y": -0.105,
        "jaw_back_y": -0.040,
        "jaw_pivot_y": -0.015,
        "jaw_pivot_z": 0.760,
        "jaw_radius_inner_x": 0.080,
        "jaw_radius_outer_x": 0.145,
        "jaw_bottom_z": 0.535,
        "jaw_lower_fade_z": 0.610,
        "shoulder_weight_radius": 0.34,
    },
    "shivaji-maharaj": {
        "object_name": "ShivajiMaharaj",
        "mouth_center_z": 0.642,
        "mouth_radius_x": 0.078,
        "mouth_inner_x": 0.038,
        "mouth_top_inner_z": 0.012,
        "mouth_top_outer_z": 0.028,
        "mouth_bottom_inner_z": 0.018,
        "mouth_bottom_outer_z": 0.044,
        "face_front_y": -0.135,
        "face_back_y": -0.105,
        "lower_lip_close_strength": 0.70,
        "upper_lip_close_strength": 0.0,
        "closed_target_offset": 0.009,
        "closed_seam": 0.0002,
        "rest_jaw_close_degrees": 5.0,
        "rest_jaw_lift": 0.0,
        "rest_jaw_retract": 0.0,
        "jaw_front_y": -0.075,
        "jaw_back_y": -0.015,
        "jaw_pivot_y": -0.010,
        "jaw_pivot_z": 0.665,
        "jaw_radius_inner_x": 0.100,
        "jaw_radius_outer_x": 0.190,
        "jaw_bottom_z": 0.430,
        "jaw_lower_fade_z": 0.520,
        "shoulder_narrowing": 0.15,
        "shoulder_weight_radius": 0.42,
    },
}
if profile_name not in PROFILES:
    raise SystemExit(f"Unknown profile: {profile_name}")
profile = PROFILES[profile_name]


def smoothstep(edge0, edge1, value):
    if edge0 == edge1:
        return 0.0
    x = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return x * x * (3.0 - 2.0 * x)


def object_world_bounds(obj):
    points = (
        [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
        if obj.type == "MESH"
        else [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    )
    minimum = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    maximum = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return minimum, maximum


bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=source_path)
target_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if len(target_meshes) != 1:
    raise RuntimeError(f"Expected one Meshy mesh, found {len(target_meshes)}")
mesh = target_meshes[0]
mesh.name = profile["object_name"]
mesh.data.name = f"{profile['object_name']}Mesh"

# Weld coincident reconstruction vertices before rigging. Meshy preserves
# many texture seams as duplicated positions; weighting those duplicates
# independently opens visible triangular cracks during arm and face motion.
editable_mesh = bmesh.new()
editable_mesh.from_mesh(mesh.data)
bmesh.ops.remove_doubles(
    editable_mesh,
    verts=list(editable_mesh.verts),
    dist=0.0001,
)
editable_mesh.to_mesh(mesh.data)
editable_mesh.free()

for polygon in mesh.data.polygons:
    polygon.use_smooth = True

bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.select_set(False)

shoulder_narrowing = profile.get("shoulder_narrowing", 0.0)
if shoulder_narrowing:
    for vertex in mesh.data.vertices:
        point = vertex.co.copy()
        lower_weight = smoothstep(0.22, 0.42, point.z)
        upper_weight = 1.0 - smoothstep(0.56, 0.68, point.z)
        point.x *= 1.0 - shoulder_narrowing * lower_weight * upper_weight
        vertex.co = point

source_min, source_max = object_world_bounds(mesh)

# Import the production Mixamo skeleton and its already-painted reference
# mesh. Both Meshy sources use the same centered T-pose proportions.
bpy.ops.import_scene.fbx(filepath=reference_path)
armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
reference_meshes = [
    obj
    for obj in bpy.context.scene.objects
    if obj.type == "MESH" and obj is not mesh and len(obj.vertex_groups) > 0
]
if len(armatures) != 1 or len(reference_meshes) != 1:
    raise RuntimeError(
        f"Expected one reference rig and mesh, found {len(armatures)} rigs "
        f"and {len(reference_meshes)} weighted meshes"
    )
armature = armatures[0]
reference_mesh = reference_meshes[0]
reference_min, reference_max = object_world_bounds(reference_mesh)

# Blender's FBX importer represents the reference mesh with compensating
# parent scale/rotation. Build a transfer-only world-space copy so nearest
# surface interpolation compares like-for-like coordinates instead of
# accidentally projecting every target vertex onto the reference feet.
weight_source = reference_mesh.copy()
weight_source.data = reference_mesh.data.copy()
bpy.context.collection.objects.link(weight_source)
reference_world = reference_mesh.matrix_world.copy()
for vertex in weight_source.data.vertices:
    vertex.co = reference_world @ vertex.co
weight_source.parent = None
weight_source.matrix_world.identity()
weight_source.modifiers.clear()
weight_source.name = "MixamoWeightSource"

# Match height, floor, and horizontal/depth centers before transferring
# weights. Uniform scaling preserves the new character's proportions.
source_height = source_max.z - source_min.z
reference_height = reference_max.z - reference_min.z
scale = reference_height / source_height
source_center = (source_min + source_max) * 0.5
reference_center = (reference_min + reference_max) * 0.5
mesh.scale = (scale, scale, scale)
mesh.location = Vector(
    (
        reference_center.x - source_center.x * scale,
        reference_center.y - source_center.y * scale,
        reference_min.z - source_min.z * scale,
    )
)
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.select_set(False)

# Convert the profile's centered-source facial coordinates into the
# reference skeleton's coordinate space.
aligned = dict(profile)
aligned["mouth_center_z"] = (
    profile["mouth_center_z"] * scale + reference_min.z - source_min.z * scale
)
aligned["jaw_pivot_z"] = (
    profile["jaw_pivot_z"] * scale + reference_min.z - source_min.z * scale
)
aligned["jaw_bottom_z"] = (
    profile["jaw_bottom_z"] * scale + reference_min.z - source_min.z * scale
)
aligned["jaw_lower_fade_z"] = (
    profile["jaw_lower_fade_z"] * scale + reference_min.z - source_min.z * scale
)
for key in (
    "mouth_radius_x",
    "mouth_inner_x",
    "mouth_top_inner_z",
    "mouth_top_outer_z",
    "mouth_bottom_inner_z",
    "mouth_bottom_outer_z",
    "jaw_radius_inner_x",
    "jaw_radius_outer_x",
    "closed_seam",
    "closed_target_offset",
    "rest_jaw_lift",
    "rest_jaw_retract",
):
    aligned[key] = profile[key] * scale
aligned["face_front_y"] = (
    profile["face_front_y"] * scale
    + reference_center.y
    - source_center.y * scale
)
aligned["face_back_y"] = (
    profile["face_back_y"] * scale
    + reference_center.y
    - source_center.y * scale
)
aligned["jaw_pivot_y"] = (
    profile["jaw_pivot_y"] * scale
    + reference_center.y
    - source_center.y * scale
)
aligned["jaw_front_y"] = (
    profile["jaw_front_y"] * scale
    + reference_center.y
    - source_center.y * scale
)
aligned["jaw_back_y"] = (
    profile["jaw_back_y"] * scale
    + reference_center.y
    - source_center.y * scale
)

# Transfer the proven Mixamo vertex groups by nearest surface interpolation.
# This preserves smooth joint transitions across different clothing while
# retaining the exact production bone names used by Avatar3D's retargeter.
for group in reference_mesh.vertex_groups:
    mesh.vertex_groups.new(name=group.name)
transfer = mesh.modifiers.new("TransferMixamoWeights", "DATA_TRANSFER")
transfer.object = weight_source
transfer.use_vert_data = True
transfer.data_types_verts = {"VGROUP_WEIGHTS"}
transfer.vert_mapping = "NEAREST"
transfer.layers_vgroup_select_src = "ALL"
transfer.layers_vgroup_select_dst = "NAME"
transfer.mix_mode = "REPLACE"
transfer.mix_factor = 1.0
transfer.use_object_transform = False
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.modifier_apply(modifier=transfer.name)
pre_limit_coverage = {group.name: 0 for group in mesh.vertex_groups}
for vertex in mesh.data.vertices:
    for membership in vertex.groups:
        if membership.weight > 0.001:
            pre_limit_coverage[mesh.vertex_groups[membership.group].name] += 1
print(
    {
        "transfer_coverage": {
            name: count
            for name, count in pre_limit_coverage.items()
            if count > 0
        }
    }
)
bpy.ops.object.vertex_group_clean(
    group_select_mode="ALL",
    limit=0.001,
    keep_single=True,
)
bpy.ops.object.vertex_group_limit_total(
    group_select_mode="ALL",
    limit=4,
)
bpy.ops.object.vertex_group_normalize_all(
    group_select_mode="ALL",
    lock_active=False,
)
mesh.select_set(False)

# Nearest-surface transfer is a useful first pass for the torso and
# clothing, but it is unsafe where surfaces sit close together. Fingers can
# inherit thumb/forearm weights and facial vertices can blend with the neck,
# producing the tearing and stretched faces seen in large gestures. Replace
# those regions with anatomy-constrained weights: rigid head and hands, and
# two-bone blends only in the elbow/wrist transition bands.
group_by_name = {group.name: group for group in mesh.vertex_groups}
required_override_groups = (
    "mixamorig:Head",
    "mixamorig:Neck",
    "mixamorig:Spine2",
    "mixamorig:LeftShoulder",
    "mixamorig:LeftArm",
    "mixamorig:LeftForeArm",
    "mixamorig:LeftHand",
    "mixamorig:RightShoulder",
    "mixamorig:RightArm",
    "mixamorig:RightForeArm",
    "mixamorig:RightHand",
)
missing_override_groups = [
    name for name in required_override_groups if name not in group_by_name
]
if missing_override_groups:
    raise RuntimeError(f"Missing override groups: {missing_override_groups}")


def replace_vertex_weights(vertex, assignments):
    existing_group_indices = [
        membership.group for membership in vertex.groups
    ]
    for group_index in existing_group_indices:
        mesh.vertex_groups[group_index].remove([vertex.index])
    total = sum(weight for _, weight in assignments)
    if total <= 0.0:
        raise RuntimeError(f"Empty weight override for vertex {vertex.index}")
    for group_name, weight in assignments:
        if weight > 0.0001:
            group_by_name[group_name].add(
                [vertex.index],
                weight / total,
                "REPLACE",
            )


arm_samples = [
    vertex.co
    for vertex in mesh.data.vertices
    if 0.43 <= abs(vertex.co.x) <= 0.55
    and 0.28 <= vertex.co.z <= 0.58
]
if not arm_samples:
    raise RuntimeError("Could not locate T-pose forearm samples")
arm_center_y = statistics.median(point.y for point in arm_samples)
arm_center_z = statistics.median(point.z for point in arm_samples)

# Meshy exports facial hair, heads, and headwear as disconnected shells.
# Classify whole head shells instead of selecting every vertex above a flat
# height plane; the latter incorrectly captures necklaces and shoulder cloth.
neighbors = [set() for _ in mesh.data.vertices]
for edge in mesh.data.edges:
    first, second = edge.vertices
    neighbors[first].add(second)
    neighbors[second].add(first)
unvisited = set(range(len(mesh.data.vertices)))
head_component_vertices = set()
torso_component_vertices = set()
while unvisited:
    seed = unvisited.pop()
    stack = [seed]
    component = [seed]
    while stack:
        for neighbor in neighbors[stack.pop()]:
            if neighbor in unvisited:
                unvisited.remove(neighbor)
                stack.append(neighbor)
                component.append(neighbor)
    points = [mesh.data.vertices[index].co for index in component]
    minimum_z = min(point.z for point in points)
    maximum_z = max(point.z for point in points)
    minimum_x = min(point.x for point in points)
    maximum_x = max(point.x for point in points)
    if (
        minimum_z >= 0.35
        and maximum_z >= 0.70
        and maximum_x - minimum_x <= 0.60
    ):
        head_component_vertices.update(component)
    elif (
        minimum_z >= 0.15
        and maximum_z <= 0.70
        and minimum_x >= -0.32
        and maximum_x <= 0.32
    ):
        torso_component_vertices.update(component)

for vertex in mesh.data.vertices:
    point = vertex.co

    # Keep complete face/hair/headwear shells rigid. A small high-center
    # fallback covers any head surface fused into a larger body shell.
    if (
        vertex.index in head_component_vertices
        or (point.z >= 0.70 and abs(point.x) <= 0.24)
    ):
        replace_vertex_weights(vertex, (("mixamorig:Head", 1.0),))
        continue
    if vertex.index in torso_component_vertices:
        replace_vertex_weights(vertex, (("mixamorig:Spine2", 1.0),))
        continue

    side = "Left" if point.x >= 0.0 else "Right"
    if (
        profile_name == "rani-laxmi-bai"
        and point.z <= -0.72
    ):
        leg_name = f"mixamorig:{side}Leg"
        foot_name = f"mixamorig:{side}Foot"
        # Keep the scan's plated footwear rigid, with only a narrow ankle
        # transition. A broad leg/foot blend shears its long triangles into
        # the horizontal spikes visible around the boots.
        foot_weight = 1.0 - smoothstep(-0.76, -0.72, point.z)
        replace_vertex_weights(
            vertex,
            (
                (leg_name, 1.0 - foot_weight),
                (foot_name, foot_weight),
            ),
        )
        continue

    distance_from_arm_axis = math.hypot(
        point.y - arm_center_y,
        point.z - arm_center_z,
    )
    vertical_arm_distance = abs(point.z - arm_center_z)
    axial = abs(point.x)
    arm_radius = (
        profile["shoulder_weight_radius"]
        if axial < 0.33
        else 0.145
    )
    if (
        axial >= 0.17
        and distance_from_arm_axis <= arm_radius
        and (axial >= 0.33 or vertical_arm_distance <= 0.25)
    ):
        shoulder_name = f"mixamorig:{side}Shoulder"
        arm_name = f"mixamorig:{side}Arm"
        forearm_name = f"mixamorig:{side}ForeArm"
        hand_name = f"mixamorig:{side}Hand"
        if axial < 0.23:
            shoulder_weight = smoothstep(0.17, 0.23, axial)
            replace_vertex_weights(
                vertex,
                (
                    ("mixamorig:Spine2", 1.0 - shoulder_weight),
                    (shoulder_name, shoulder_weight),
                ),
            )
        elif axial < 0.32:
            arm_weight = smoothstep(0.23, 0.32, axial)
            replace_vertex_weights(
                vertex,
                (
                    (shoulder_name, 1.0 - arm_weight),
                    (arm_name, arm_weight),
                ),
            )
        elif axial < 0.385:
            replace_vertex_weights(vertex, ((arm_name, 1.0),))
        elif axial < 0.445:
            forearm_weight = smoothstep(0.385, 0.445, axial)
            replace_vertex_weights(
                vertex,
                (
                    (arm_name, 1.0 - forearm_weight),
                    (forearm_name, forearm_weight),
                ),
            )
        elif axial < 0.585:
            replace_vertex_weights(vertex, ((forearm_name, 1.0),))
        elif axial < 0.645:
            hand_weight = smoothstep(0.585, 0.645, axial)
            replace_vertex_weights(
                vertex,
                (
                    (forearm_name, 1.0 - hand_weight),
                    (hand_name, hand_weight),
                ),
            )
        else:
            # Keep the entire hand rigid. These Meshy meshes have fused
            # fingers rather than animation-ready finger loops, so assigning
            # thumb/finger bones only tears the palm apart.
            replace_vertex_weights(vertex, ((hand_name, 1.0),))

bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.vertex_group_clean(
    group_select_mode="ALL",
    limit=0.001,
    keep_single=True,
)
bpy.ops.object.vertex_group_limit_total(
    group_select_mode="ALL",
    limit=4,
)
bpy.ops.object.vertex_group_normalize_all(
    group_select_mode="ALL",
    lock_active=False,
)
mesh.select_set(False)

armature_modifier = mesh.modifiers.new("Armature", "ARMATURE")
armature_modifier.object = armature
armature_modifier.use_vertex_groups = True
armature_modifier.use_bone_envelopes = False
mesh.parent = armature
# Match the reference mesh's exact armature-local bind transform. A merely
# equivalent world matrix is insufficient for glTF inverse bind matrices and
# causes geometry to separate from bones as soon as an animation is applied.
mesh.matrix_parent_inverse = reference_mesh.matrix_parent_inverse.copy()
mesh.matrix_basis = reference_mesh.matrix_basis.copy()

# The reference geometry is no longer needed after its normalized skin
# weights have been transferred.
bpy.data.objects.remove(weight_source, do_unlink=True)
bpy.data.objects.remove(reference_mesh, do_unlink=True)


def mouth_weight(point):
    x_weight = 1.0 - smoothstep(
        aligned["mouth_inner_x"],
        aligned["mouth_radius_x"],
        abs(point.x),
    )
    vertical_offset = point.z - aligned["mouth_center_z"]
    if vertical_offset >= 0.0:
        z_weight = 1.0 - smoothstep(
            aligned["mouth_top_inner_z"],
            aligned["mouth_top_outer_z"],
            vertical_offset,
        )
    else:
        z_weight = 1.0 - smoothstep(
            aligned["mouth_bottom_inner_z"],
            aligned["mouth_bottom_outer_z"],
            -vertical_offset,
        )
    front_weight = 1.0 - smoothstep(
        aligned["face_front_y"],
        aligned["face_back_y"],
        point.y,
    )
    return max(0.0, x_weight * z_weight * front_weight)


def lower_jaw_weight(point):
    if point.z >= aligned["mouth_center_z"]:
        return 0.0
    x_weight = 1.0 - smoothstep(
        aligned["jaw_radius_inner_x"],
        aligned["jaw_radius_outer_x"],
        abs(point.x),
    )
    lower_weight = smoothstep(
        aligned["jaw_bottom_z"],
        aligned["jaw_lower_fade_z"],
        point.z,
    )
    upper_weight = 1.0 - smoothstep(
        aligned["mouth_center_z"] - 0.035 * scale,
        aligned["mouth_center_z"],
        point.z,
    )
    front_weight = 1.0 - smoothstep(
        aligned["jaw_front_y"],
        aligned["jaw_back_y"],
        point.y,
    )
    return max(0.0, x_weight * lower_weight * upper_weight * front_weight)


def set_shape(shape, original_points, transform):
    for index, original in enumerate(original_points):
        shape.data[index].co = transform(
            original.copy(),
            mouth_weight(original),
            lower_jaw_weight(original),
        )


def closed_pose(point, lip_weight, jaw_weight=0.0):
    if lip_weight <= 0.0 and jaw_weight <= 0.0:
        return point
    was_lower_lip = point.z < aligned["mouth_center_z"]

    # Close the lower jaw as one coherent region. A small lift/retraction is
    # safer for generated single-shell topology than rotating only a sparse
    # lip ring, which stretches its long cheek/chin triangles.
    point.z += aligned["rest_jaw_lift"] * jaw_weight
    point.y += aligned["rest_jaw_retract"] * jaw_weight
    close_angle = -math.radians(
        aligned["rest_jaw_close_degrees"]
    ) * jaw_weight
    if close_angle:
        dy = point.y - aligned["jaw_pivot_y"]
        dz = point.z - aligned["jaw_pivot_z"]
        point.y = (
            aligned["jaw_pivot_y"]
            + math.cos(close_angle) * dy
            - math.sin(close_angle) * dz
        )
        point.z = (
            aligned["jaw_pivot_z"]
            + math.sin(close_angle) * dy
            + math.cos(close_angle) * dz
        )

    if lip_weight <= 0.0:
        return point
    target_seam = (
        aligned["mouth_center_z"] + aligned["closed_target_offset"]
    )
    seam = (
        target_seam + aligned["closed_seam"]
        if not was_lower_lip
        else target_seam - aligned["closed_seam"]
    )
    close_strength = (
        aligned["lower_lip_close_strength"]
        if was_lower_lip
        else aligned["upper_lip_close_strength"]
    )
    point.z += (
        seam - point.z
    ) * close_strength * lip_weight
    # The authored open-mouth lower lip and tongue sit forward. Retract
    # them behind the upper lip in neutral so the closed seam has depth
    # instead of leaving a puckered oval or visible inner-mouth strip.
    retract = 0.026 if was_lower_lip else 0.008
    point.y += retract * scale * lip_weight
    return point


def make_viseme_transform(
    horizontal,
    openness,
    jaw_angle,
    protrude=0.0,
    jaw_forward=0.0,
):
    def transform(point, lip_weight, jaw_weight):
        if lip_weight <= 0.0 and jaw_weight <= 0.0:
            return point
        posed = closed_pose(point.copy(), lip_weight, jaw_weight)
        posed.z += (point.z - posed.z) * openness
        posed.x += point.x * horizontal * lip_weight
        posed.y -= protrude * scale * lip_weight

        # The source is already authored open. The openness interpolation
        # recovers that original jaw position; only a very small coherent
        # extra drop is needed for the widest vowels.
        jaw_drop = math.radians(jaw_angle) * 0.025 * scale * jaw_weight
        posed.z -= jaw_drop
        posed.y -= jaw_forward * scale * jaw_weight
        return posed

    return transform


original_points = [vertex.co.copy() for vertex in mesh.data.vertices]
basis = mesh.shape_key_add(name="Basis", from_mix=False)
viseme_aa = mesh.shape_key_add(name="viseme_aa", from_mix=False)
for index, point in enumerate(original_points):
    viseme_aa.data[index].co = point
set_shape(basis, original_points, closed_pose)

shape_transforms = {
    "viseme_FF": make_viseme_transform(0.02, 0.16, 1.5),
    "viseme_TH": make_viseme_transform(0.00, 0.30, 3.0, jaw_forward=0.004),
    "viseme_DD": make_viseme_transform(0.01, 0.32, 3.0),
    "viseme_kk": make_viseme_transform(0.00, 0.40, 4.0),
    "viseme_CH": make_viseme_transform(-0.04, 0.34, 4.0, protrude=0.005),
    "viseme_SS": make_viseme_transform(0.05, 0.20, 2.0),
    "viseme_nn": make_viseme_transform(0.00, 0.26, 2.5),
    "viseme_RR": make_viseme_transform(-0.03, 0.40, 4.0, protrude=0.004),
    "viseme_E": make_viseme_transform(0.10, 0.46, 4.5, jaw_forward=0.004),
    "viseme_I": make_viseme_transform(0.12, 0.38, 3.5),
    "viseme_O": make_viseme_transform(
        -0.12,
        0.58,
        6.5,
        protrude=0.010,
        jaw_forward=0.008,
    ),
    "viseme_U": make_viseme_transform(
        -0.16,
        0.38,
        4.5,
        protrude=0.013,
        jaw_forward=0.006,
    ),
}
viseme_pp = mesh.shape_key_add(name="viseme_PP", from_mix=False)
for index, point in enumerate(basis.data):
    viseme_pp.data[index].co = point.co
for name, transform in shape_transforms.items():
    shape = mesh.shape_key_add(name=name, from_mix=False)
    set_shape(shape, original_points, transform)
set_shape(
    viseme_aa,
    original_points,
    make_viseme_transform(-0.02, 0.82, 7.5, jaw_forward=0.010),
)

for shape in mesh.data.shape_keys.key_blocks:
    shape.value = 0.0
    shape.slider_min = 0.0
    shape.slider_max = 1.0

unweighted = 0
over_four = 0
bad_weight_sums = 0
group_coverage = {group.name: 0 for group in mesh.vertex_groups}
for vertex in mesh.data.vertices:
    weights = [group.weight for group in vertex.groups if group.weight > 0.001]
    for membership in vertex.groups:
        if membership.weight > 0.001:
            group_coverage[mesh.vertex_groups[membership.group].name] += 1
    if not weights:
        unweighted += 1
    if len(weights) > 4:
        over_four += 1
    if weights and abs(sum(weights) - 1.0) > 0.01:
        bad_weight_sums += 1
required_weight_groups = (
    "mixamorig:Hips",
    "mixamorig:Spine",
    "mixamorig:Head",
    "mixamorig:LeftArm",
    "mixamorig:RightArm",
    "mixamorig:LeftForeArm",
    "mixamorig:RightForeArm",
    "mixamorig:LeftUpLeg",
    "mixamorig:RightUpLeg",
    "mixamorig:LeftLeg",
    "mixamorig:RightLeg",
)
missing_required_groups = [
    name for name in required_weight_groups if group_coverage.get(name, 0) == 0
]
if unweighted or over_four or bad_weight_sums or missing_required_groups:
    raise RuntimeError(
        "Skin validation failed: "
        f"{unweighted} unweighted, {over_four} over four influences, "
        f"{bad_weight_sums} non-normalized, "
        f"missing deform groups {missing_required_groups}"
    )

os.makedirs(os.path.dirname(output_path), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = mesh
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_animations=False,
    export_morph=True,
    export_morph_normal=True,
    export_skins=True,
    export_all_influences=False,
    export_influence_nb=4,
    export_apply=False,
)

print(
    {
        "profile": profile_name,
        "output": output_path,
        "vertices": len(mesh.data.vertices),
        "bones": len(armature.data.bones),
        "vertex_groups": len(mesh.vertex_groups),
        "shape_keys": [shape.name for shape in mesh.data.shape_keys.key_blocks],
        "size_bytes": os.path.getsize(output_path),
        "skin_validation": {
            "unweighted": unweighted,
            "over_four": over_four,
            "non_normalized": bad_weight_sums,
            "missing_required_groups": missing_required_groups,
        },
    }
)
