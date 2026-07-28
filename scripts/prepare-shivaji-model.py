"""Prepare the supplied Meshy Shivaji GLB for the kiosk.

The source is a single unrigged mesh with an open mouth. This script:
1. adds a closed-mouth Basis and Oculus-style viseme shape keys;
2. lowers the source T-pose arms into a relaxed standing rest pose;
3. adds a subtle chest-breathing morph;
4. exports a self-contained morph-target GLB.

Run with Blender:
  blender --background --python scripts/prepare-shivaji-model.py -- \
    <source.glb> public/models/shivaji-maharaj.glb
"""

import math
import os
import sys

import bpy
args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) != 2:
    raise SystemExit("Expected: <source.glb> <output.glb>")

source_path, output_path = map(os.path.abspath, args)

MOUTH_CENTER_Z = 0.642
MOUTH_RADIUS_X = 0.078
MOUTH_INNER_X = 0.038
MOUTH_TOP_INNER_Z = 0.012
MOUTH_TOP_OUTER_Z = 0.028
MOUTH_BOTTOM_INNER_Z = 0.018
MOUTH_BOTTOM_OUTER_Z = 0.044
FACE_FRONT_Y = -0.135
SHOULDER_NARROWING = 0.15
JAW_PIVOT_Y = -0.01
JAW_PIVOT_Z = 0.665


def smoothstep(edge0, edge1, value):
    if edge0 == edge1:
        return 0.0
    x = max(0.0, min(1.0, (value - edge0) / (edge1 - edge0)))
    return x * x * (3.0 - 2.0 * x)


def mouth_weight(point):
    x_weight = 1.0 - smoothstep(MOUTH_INNER_X, MOUTH_RADIUS_X, abs(point.x))
    vertical_offset = point.z - MOUTH_CENTER_Z
    if vertical_offset >= 0.0:
        z_weight = 1.0 - smoothstep(
            MOUTH_TOP_INNER_Z,
            MOUTH_TOP_OUTER_Z,
            vertical_offset,
        )
    else:
        z_weight = 1.0 - smoothstep(
            MOUTH_BOTTOM_INNER_Z,
            MOUTH_BOTTOM_OUTER_Z,
            -vertical_offset,
        )
    front_weight = 1.0 - smoothstep(FACE_FRONT_Y, -0.105, point.y)
    return max(0.0, x_weight * z_weight * front_weight)


def lower_jaw_weight(point):
    if point.z >= MOUTH_CENTER_Z:
        return 0.0
    x_weight = 1.0 - smoothstep(0.10, 0.19, abs(point.x))
    lower_weight = smoothstep(0.43, 0.52, point.z)
    upper_weight = 1.0 - smoothstep(0.625, MOUTH_CENTER_Z, point.z)
    front_weight = 1.0 - smoothstep(-0.075, -0.015, point.y)
    return max(0.0, x_weight * lower_weight * upper_weight * front_weight)


def set_shape(shape, original_points, transform):
    for index, original in enumerate(original_points):
        lip_weight = mouth_weight(original)
        jaw_weight = lower_jaw_weight(original)
        shape.data[index].co = transform(
            original.copy(),
            lip_weight,
            jaw_weight,
        )


def closed_pose(point, lip_weight, _jaw_weight=0.0):
    if lip_weight <= 0.0:
        return point
    # Collapse the opening toward the natural lip seam. The smooth spatial
    # falloff keeps cheeks, moustache and beard fixed.
    point.z += (MOUTH_CENTER_Z - point.z) * 0.86 * lip_weight
    point.y -= 0.006 * lip_weight
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
        posed = closed_pose(point.copy(), lip_weight)
        dx = point.x
        # Reopen from the authored neutral seam toward the source mouth.
        # 0 keeps a consonant closed; 1 restores the full source opening.
        posed.z += (point.z - posed.z) * openness
        posed.x += dx * horizontal * lip_weight
        posed.y -= protrude * lip_weight

        # The source has no skeleton, so rotate a softly weighted lower-face
        # region around an anatomical hinge to emulate mandible motion.
        angle = math.radians(jaw_angle) * jaw_weight
        if angle > 0.0:
            dy = posed.y - JAW_PIVOT_Y
            dz = posed.z - JAW_PIVOT_Z
            posed.y = (
                JAW_PIVOT_Y
                + math.cos(angle) * dy
                - math.sin(angle) * dz
                - jaw_forward * jaw_weight
            )
            posed.z = (
                JAW_PIVOT_Z
                + math.sin(angle) * dy
                + math.cos(angle) * dz
            )
        return posed

    return transform


bpy.ops.wm.read_factory_settings(use_empty=True)

# Import the target mesh first so it is easy to distinguish from reference
# FBX objects after the rig import.
bpy.ops.import_scene.gltf(filepath=source_path)
target_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
if len(target_meshes) != 1:
    raise RuntimeError(f"Expected one Meshy mesh, found {len(target_meshes)}")
mesh = target_meshes[0]
mesh.name = "ShivajiMaharaj"
mesh.data.name = "ShivajiMaharajMesh"

# Apply the GLB node transform before creating shape keys and skin weights.
bpy.context.view_layer.objects.active = mesh
mesh.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mesh.select_set(False)

# Lower both arms from Meshy's T-pose. The source is one watertight mesh,
# so a smooth shoulder falloff avoids seams while keeping the torso fixed.
for vertex in mesh.data.vertices:
    point = vertex.co.copy()
    side = 1.0 if point.x >= 0.0 else -1.0
    horizontal = abs(point.x)
    if horizontal <= 0.22 or point.z <= 0.15:
        continue
    shoulder_weight = smoothstep(0.22, 0.36, horizontal)
    height_weight = smoothstep(0.15, 0.32, point.z)
    weight = shoulder_weight * height_weight
    # A near-vertical 82° rest pose keeps the hands close to the hips and
    # reads as a firm warrior's stance instead of a softened partial T-pose.
    angle = side * math.radians(82.0) * weight
    pivot_x = side * 0.25
    pivot_z = 0.46
    dx = point.x - pivot_x
    dz = point.z - pivot_z
    point.x = pivot_x + math.cos(angle) * dx + math.sin(angle) * dz
    point.z = pivot_z - math.sin(angle) * dx + math.cos(angle) * dz

    # A relaxed arm is not a rigid vertical line. Add a small elbow flex
    # toward the torso, blended across the sleeve so the forearm and hand
    # settle naturally without pinching the elbow seam.
    forearm_weight = smoothstep(0.48, 0.61, horizontal) * weight
    if forearm_weight > 0.0:
        elbow_distance = 0.29
        elbow_x = pivot_x + math.cos(side * math.radians(82.0)) * (
            side * elbow_distance
        )
        elbow_z = pivot_z - math.sin(side * math.radians(82.0)) * (
            side * elbow_distance
        )
        elbow_angle = side * math.radians(14.0) * forearm_weight
        dx = point.x - elbow_x
        dz = point.z - elbow_z
        point.x = (
            elbow_x + math.cos(elbow_angle) * dx + math.sin(elbow_angle) * dz
        )
        point.z = (
            elbow_z - math.sin(elbow_angle) * dx + math.cos(elbow_angle) * dz
        )
    vertex.co = point

# Bring the shoulder envelope back to an athletic human proportion without
# flattening the chest or narrowing the head. The smooth vertical falloff
# keeps the upper arms continuous with the torso and leaves the hands fixed.
for vertex in mesh.data.vertices:
    point = vertex.co.copy()
    lower_weight = smoothstep(0.22, 0.42, point.z)
    upper_weight = 1.0 - smoothstep(0.56, 0.68, point.z)
    shoulder_weight = lower_weight * upper_weight
    point.x *= 1.0 - SHOULDER_NARROWING * shoulder_weight
    vertex.co = point

original_points = [vertex.co.copy() for vertex in mesh.data.vertices]
basis = mesh.shape_key_add(name="Basis", from_mix=False)
viseme_aa = mesh.shape_key_add(name="viseme_aa", from_mix=False)
for index, point in enumerate(original_points):
    viseme_aa.data[index].co = point

set_shape(basis, original_points, closed_pose)

# Exhale remains the neutral geometry; this target represents a restrained
# inhale. The falloffs isolate the ribcage so the head, waist, arms, and
# planted feet stay stable.
breathing = mesh.shape_key_add(name="breathing", from_mix=False)
for index, original in enumerate(original_points):
    point = closed_pose(original.copy(), mouth_weight(original))
    lower_weight = smoothstep(0.27, 0.40, point.z)
    upper_weight = 1.0 - smoothstep(0.57, 0.70, point.z)
    center_weight = 1.0 - smoothstep(0.25, 0.43, abs(point.x))
    weight = lower_weight * upper_weight * center_weight
    point.x *= 1.0 + 0.007 * weight
    point.y *= 1.0 + 0.012 * weight
    point.z += 0.004 * weight
    breathing.data[index].co = point

# Oculus-style names are intentionally used: Avatar3D can also consume
# Ready Player Me/ARKit aliases, but these remain compact and predictable.
shape_transforms = {
    "viseme_PP": make_viseme_transform(-0.03, 0.00, 0.0),
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
    "viseme_O": make_viseme_transform(-0.12, 0.58, 6.5, protrude=0.010, jaw_forward=0.008),
    "viseme_U": make_viseme_transform(-0.16, 0.38, 4.5, protrude=0.013, jaw_forward=0.006),
}
for name, transform in shape_transforms.items():
    shape = mesh.shape_key_add(name=name, from_mix=False)
    set_shape(shape, original_points, transform)

# AA uses the largest jaw opening while retaining the source lip shape.
set_shape(
    viseme_aa,
    original_points,
    make_viseme_transform(-0.02, 0.82, 7.5, jaw_forward=0.010),
)

# Keep export deterministic and avoid carrying Blender-only display state.
mesh.show_wire = False
for shape in mesh.data.shape_keys.key_blocks:
    shape.value = 0.0
    shape.slider_min = 0.0
    shape.slider_max = 1.0

os.makedirs(os.path.dirname(output_path), exist_ok=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
bpy.context.view_layer.objects.active = mesh
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_animations=False,
    export_morph=True,
    export_morph_normal=True,
    export_skins=False,
    export_apply=False,
)

print(
    {
        "output": output_path,
        "vertices": len(mesh.data.vertices),
        "shape_keys": [shape.name for shape in mesh.data.shape_keys.key_blocks],
        "size_bytes": os.path.getsize(output_path),
    }
)
