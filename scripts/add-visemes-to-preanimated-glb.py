"""Add facial visemes without changing the supplied body geometry or rig.

For rigged inputs, the skeleton, skin weights, bind matrices, and embedded
animation actions are imported and exported untouched. Static FBX/GLB skins
are also supported: their original mesh is exported without adding a rig or
body animation. In both cases only morph targets in the facial region change.

Run with Blender:
  blender --background --python scripts/add-visemes-to-preanimated-glb.py -- \
    <sandipani|rani-laxmi-bai|shivaji-maharaj> <input.glb> <output.glb> \
    [material-source.fbx]

Set AVATAR_DECIMATE_RATIO (for example 0.38) only when producing the optional
low-end bundle. Production bundles keep the supplied body mesh byte-for-byte.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

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
        "face_front_y": -0.0820,
        "face_back_y": -0.0580,
        # Close the authored lower-lip seam in neutral without moving the
        # moustache, upper lip, beard, or jaw.
        "lower_close": 1.05,
        "upper_close": 0.0,
        "lower_forward_close": -0.0015,
        "upper_forward_close": 0.0,
        "closed_offset": 0.0040,
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
        "lower_lip_open": 0.0250,
        "lower_lip_center_offset_z": 0.0050,
        "lower_lip_inner_x": 0.0060,
        "lower_lip_outer_x": 0.0110,
        "lower_lip_inner_z": 0.0050,
        "lower_lip_outer_z": 0.0120,
        # The visible lip sits just behind the moustache shell. Select a
        # narrow depth band so speech never pulls beard/moustache triangles.
        "lower_lip_explicit_band": True,
        "lower_lip_min_z": 0.8400,
        "lower_lip_peak_min_z": 0.8460,
        "lower_lip_peak_max_z": 0.8505,
        "lower_lip_max_z": 0.8540,
        "lip_front_y": -0.0750,
        "lip_peak_front_y": -0.0720,
        "lip_peak_back_y": -0.0660,
        "lip_back_y": -0.0620,
        "cheek_inner_x": 0.0220,
        "cheek_peak_x": 0.0430,
        "cheek_outer_x": 0.0730,
        "cheek_lower_z": 0.0080,
        "cheek_peak_z": 0.0320,
        "cheek_upper_z": 0.0700,
        "cheek_out": 0.0022,
        "cheek_up": 0.0018,
        "cheek_forward": 0.0011,
        # The supplied scan bakes a bright row of teeth into a compact set
        # of mouth-cavity triangles. Split only those triangles onto a matte
        # black material so speech reads as a hollow mouth, while lips,
        # moustache, beard, skin, body, bones and animation remain untouched.
        "dark_mouth_cavity": False,
        "cavity_max_x": 0.0080,
        "cavity_min_y": -0.0830,
        "cavity_max_y": -0.0760,
        "cavity_min_z": 0.8580,
        "cavity_max_z": 0.8720,
        # The scan's baked teeth share long triangles with the nose, so a
        # material split or broader morph damages the face. These two tiny,
        # head-weighted layers cover only the mouth opening in neutral; the
        # lip layer is hidden by the runtime while speech visemes are active.
        "idle_mouth_overlay": True,
        "overlay_center_z": 0.8495,
        "overlay_front_y": -0.0740,
        "overlay_radius_x": 0.0110,
        "cavity_radius_z": 0.0032,
        "lip_radius_z": 0.0052,
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
        "lower_close": 1.0,
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
        # This scan has sparse, asymmetric triangles around the lips. Reusing
        # the authored open-mouth surface pinches one corner. Keep the upper
        # lip fixed and articulate a compact, symmetric lower-lip band.
        "lower_lip_visemes": True,
        "lower_lip_open": 0.0140,
        "lower_lip_inner_x": 0.0020,
        "lower_lip_outer_x": 0.0180,
        "lower_lip_inner_z": 0.0010,
        "lower_lip_outer_z": 0.0120,
        "cheek_inner_x": 0.0140,
        "cheek_peak_x": 0.0290,
        "cheek_outer_x": 0.0550,
        "cheek_lower_z": 0.0060,
        "cheek_peak_z": 0.0240,
        "cheek_upper_z": 0.0580,
        "cheek_out": 0.0018,
        "cheek_up": 0.0015,
        "cheek_forward": 0.0009,
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
        "lower_close": 1.0,
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
        "source_open_only": True,
        "source_open_scale": 1.22,
        # Keep the upper face, beard, neck and chest completely fixed. The
        # previous broad jaw mask included tens of thousands of connected
        # torso vertices and made the necklaces/chest pulse with speech.
        "lower_lip_visemes": True,
        "lower_lip_open": 0.0240,
        "lower_lip_inner_x": 0.0030,
        "lower_lip_outer_x": 0.0260,
        "lower_lip_inner_z": 0.0010,
        "lower_lip_outer_z": 0.0120,
        "cheek_inner_x": 0.0200,
        "cheek_peak_x": 0.0420,
        "cheek_outer_x": 0.0720,
        "cheek_lower_z": 0.0080,
        "cheek_peak_z": 0.0300,
        "cheek_upper_z": 0.0640,
        "cheek_out": 0.0021,
        "cheek_up": 0.0017,
        "cheek_forward": 0.0010,
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

# Optional, deliberately separate low-end asset. The production path never
# sets this variable, so the supplied character body remains untouched.
decimate_ratio = float(os.environ.get("AVATAR_DECIMATE_RATIO", "1"))
if decimate_ratio < 0.999:
    if not 0.2 <= decimate_ratio <= 0.8:
        raise RuntimeError("AVATAR_DECIMATE_RATIO must be between 0.2 and 0.8")
    bpy.context.view_layer.objects.active = mesh
    mesh.select_set(True)
    modifier = mesh.modifiers.new(name="LowEndMesh", type="DECIMATE")
    modifier.ratio = decimate_ratio
    modifier.use_collapse_triangulate = True
    # Decimate the bind mesh before the Armature modifier. Applying it below
    # an evaluated pose would bake the current idle deformation into the body.
    mesh.modifiers.move(len(mesh.modifiers) - 1, 0)
    bpy.ops.object.modifier_apply(modifier=modifier.name)

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


def darken_mouth_cavity():
    if not profile.get("dark_mouth_cavity"):
        return 0
    selected_polygons = []

    for polygon in mesh.data.polygons:
        center = sum(
            (points[index] for index in polygon.vertices),
            points[polygon.vertices[0]] * 0.0,
        ) / len(polygon.vertices)
        normalized_x = (center.x - mouth_center_x) / height
        normalized_y = center.y / height
        normalized_z = (center.z - minimum_z) / height
        if (
            abs(normalized_x) > profile["cavity_max_x"]
            or normalized_y < profile["cavity_min_y"]
            or normalized_y > profile["cavity_max_y"]
            or normalized_z < profile["cavity_min_z"]
            or normalized_z > profile["cavity_max_z"]
        ):
            continue

        selected_polygons.append(polygon)

    if not selected_polygons:
        raise RuntimeError("No Sandipani tooth polygons matched the cavity mask")

    cavity_material = bpy.data.materials.new(name="MouthCavity")
    cavity_material.diffuse_color = (0.002, 0.001, 0.001, 1.0)
    cavity_material.use_nodes = True
    principled = cavity_material.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = (0.002, 0.001, 0.001, 1.0)
        principled.inputs["Roughness"].default_value = 0.92
        principled.inputs["Metallic"].default_value = 0.0
    mesh.data.materials.append(cavity_material)
    cavity_index = len(mesh.data.materials) - 1
    for polygon in selected_polygons:
        polygon.material_index = cavity_index
    return len(selected_polygons)


darkened_cavity_polygons = darken_mouth_cavity()


facial_overlays = []


def add_mouth_overlay(name, radius_x, radius_z, color, front_offset=0.0):
    if not armature:
        raise RuntimeError("Sandipani mouth overlay requires the supplied armature")
    head_bone = next(
        (
            bone.name
            for bone in armature.data.bones
            if bone.name.lower().split(":")[-1] == "head"
        ),
        None,
    )
    if not head_bone:
        raise RuntimeError("Sandipani mouth overlay could not find the Head bone")

    center_z = minimum_z + profile["overlay_center_z"] * height
    center_y = (profile["overlay_front_y"] + front_offset) * height
    center_x = mouth_center_x
    world_vertices = [Vector((center_x, center_y, center_z))]
    if "LipSeam" in name:
        outline = [
            (1.00, 0.00),
            (0.55, 0.42),
            (0.00, 0.56),
            (-0.55, 0.42),
            (-1.00, 0.00),
            (-0.55, -0.42),
            (0.00, -0.56),
            (0.55, -0.42),
        ]
    elif "IdleLipSeal" in name:
        # Tapered, asymmetric lip silhouette (subtle cupid bow + fuller
        # lower lip) reads as a closed human mouth instead of a flat oval.
        outline = [
            (1.00, 0.00),
            (0.78, 0.28),
            (0.42, 0.56),
            (0.00, 0.72),
            (-0.42, 0.56),
            (-0.78, 0.28),
            (-1.00, 0.00),
            (-0.76, -0.24),
            (-0.38, -0.50),
            (0.00, -0.62),
            (0.38, -0.50),
            (0.76, -0.24),
        ]
    else:
        segments = 32
        outline = [
            (math.cos(math.tau * index / segments), math.sin(math.tau * index / segments))
            for index in range(segments)
        ]
    for normalized_x, normalized_z in outline:
        world_vertices.append(
            Vector(
                (
                    center_x + normalized_x * radius_x * height,
                    center_y,
                    center_z + normalized_z * radius_z * height,
                )
            )
        )
    vertices = [world_to_mesh @ point for point in world_vertices]
    segments = len(outline)
    faces = [
        (0, index + 1, ((index + 1) % segments) + 1)
        for index in range(segments)
    ]
    overlay_data = bpy.data.meshes.new(name)
    overlay_data.from_pydata(vertices, [], faces)
    overlay_data.update()
    overlay = bpy.data.objects.new(name, overlay_data)
    bpy.context.collection.objects.link(overlay)
    overlay.matrix_world = mesh.matrix_world.copy()
    overlay_world = overlay.matrix_world.copy()
    overlay.parent = armature
    overlay.matrix_world = overlay_world

    material = bpy.data.materials.new(f"{name}Material")
    material.diffuse_color = (*color, 1.0)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = (*color, 1.0)
        principled.inputs["Roughness"].default_value = 0.82
        principled.inputs["Metallic"].default_value = 0.0
    overlay_data.materials.append(material)

    armature_modifier = overlay.modifiers.new(name="Armature", type="ARMATURE")
    armature_modifier.object = armature
    head_group = overlay.vertex_groups.new(name=head_bone)
    head_group.add(range(len(vertices)), 1.0, "REPLACE")
    facial_overlays.append(overlay)
    return overlay


if profile.get("idle_mouth_overlay"):
    add_mouth_overlay(
        "SandipaniMouthCavity",
        profile["overlay_radius_x"],
        profile["cavity_radius_z"],
        (0.006, 0.003, 0.003),
    )
    add_mouth_overlay(
        "SandipaniIdleLipSeal",
        profile["overlay_radius_x"] * 1.04,
        profile["lip_radius_z"],
        (0.055, 0.004, 0.003),
        front_offset=-0.0030,
    )
    add_mouth_overlay(
        "SandipaniIdleLipSealSeam",
        profile["overlay_radius_x"] * 0.86,
        0.00055,
        (0.008, 0.002, 0.001),
        front_offset=-0.0038,
    )


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
    if profile.get("lower_lip_explicit_band"):
        x_weight = 1.0 - smoothstep(
            scaled("lower_lip_inner_x"),
            scaled("lower_lip_outer_x"),
            abs(point.x - mouth_center_x),
        )
        normalized_z = (point.z - minimum_z) / height
        z_weight = smoothstep(
            profile["lower_lip_min_z"],
            profile["lower_lip_peak_min_z"],
            normalized_z,
        ) * (
            1.0 - smoothstep(
                profile["lower_lip_peak_max_z"],
                profile["lower_lip_max_z"],
                normalized_z,
            )
        )
        normalized_y = point.y / height
        front_weight = smoothstep(
            profile["lip_front_y"],
            profile["lip_peak_front_y"],
            normalized_y,
        ) * (
            1.0 - smoothstep(
                profile["lip_peak_back_y"],
                profile["lip_back_y"],
                normalized_y,
            )
        )
        return max(0.0, x_weight * z_weight * front_weight)
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
        if "lip_peak_y" in profile:
            front_weight = smoothstep(
                scaled("lip_front_y"),
                scaled("lip_peak_y"),
                point.y,
            ) * (
                1.0 - smoothstep(
                    scaled("lip_peak_y"),
                    scaled("lip_back_y"),
                    point.y,
                )
            )
        else:
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


def cheek_weight(point):
    """Compact bilateral cheek mask; excludes lips, nose, eyes and torso."""
    horizontal = abs(point.x - mouth_center_x)
    x_weight = smoothstep(
        scaled("cheek_inner_x"),
        scaled("cheek_peak_x"),
        horizontal,
    ) * (
        1.0 - smoothstep(
            scaled("cheek_peak_x"),
            scaled("cheek_outer_x"),
            horizontal,
        )
    )
    vertical = point.z - mouth_center_z
    z_weight = smoothstep(
        scaled("cheek_lower_z"),
        scaled("cheek_peak_z"),
        vertical,
    ) * (
        1.0 - smoothstep(
            scaled("cheek_peak_z"),
            scaled("cheek_upper_z"),
            vertical,
        )
    )
    front_weight = 1.0 - smoothstep(
        scaled("face_front_y"),
        scaled("face_back_y"),
        point.y,
    )
    return max(0.0, x_weight * z_weight * front_weight)


def closed_pose(point, lip_weight, jaw_weight):
    if "lip_peak_y" in profile or profile.get("lower_lip_explicit_band"):
        lip_weight = jaw_weight
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


def speech_cheek_pose(point, lip_weight, jaw_weight):
    # Cheeks are an independent additive speech target. Lip closure/opening
    # is supplied by the active viseme, so duplicating it here would overdrive
    # the mouth whenever both targets are blended at runtime.
    posed = point.copy()
    weight = cheek_weight(point)
    if weight <= 0.0:
        return posed
    side = -1.0 if point.x < mouth_center_x else 1.0
    posed.x += side * scaled("cheek_out") * weight
    posed.z += scaled("cheek_up") * weight
    posed.y -= scaled("cheek_forward") * weight
    return posed


def set_shape(shape, transform):
    for index, original in enumerate(points):
        transformed = transform(
            original.copy(),
            mouth_weight(original),
            lower_jaw_weight(original),
        )
        if (transformed - original).length_squared <= 1e-24:
            # Preserve the exact source coordinate outside the facial mask.
            # A matrix round-trip introduces tiny float noise that makes the
            # glTF exporter serialize every vertex instead of sparse morphs.
            shape.data[index].co = mesh.data.vertices[index].co
        else:
            shape.data[index].co = world_to_mesh @ (
                analysis_to_world @ transformed
            )


basis = mesh.shape_key_add(name="Basis", from_mix=False)

viseme_pp = mesh.shape_key_add(name="viseme_PP", from_mix=False)
set_shape(viseme_pp, closed_pose)

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

speech_cheek = mesh.shape_key_add(name="speech_CheekRaise", from_mix=False)
set_shape(speech_cheek, speech_cheek_pose)

for shape in mesh.data.shape_keys.key_blocks:
    shape.value = 0.0
    shape.slider_min = 0.0
    shape.slider_max = 1.0

# Reject accidental cheek, chin, nose, neck, chest, or full-head deformation.
# Validate target deltas against the exported closed-mouth Basis, rather than
# trusting the procedural weight mask itself: a bad mask is exactly what can
# make a morph appear valid while still moving torso vertices.
locality_epsilon = height * 0.000001
maximum_lip_displacement = height * 0.065
maximum_morph_vertices = 5_000
anatomical_min_z = mouth_center_z - height * 0.055
anatomical_max_z = mouth_center_z + height * 0.030
anatomical_max_x = height * 0.060
for shape in mesh.data.shape_keys.key_blocks:
    affected_vertices = 0
    is_cheek_shape = shape.name == "speech_CheekRaise"
    for index, original in enumerate(points):
        shaped = analysis_rotation @ (mesh_to_world @ shape.data[index].co)
        displacement = (shaped - original).length
        allowed_weight = max(
            mouth_weight(original),
            lower_jaw_weight(original),
            cheek_weight(original) if is_cheek_shape else 0.0,
        )
        if (
            allowed_weight <= 0.000001
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
        if shape != basis:
            basis_point = analysis_rotation @ (
                mesh_to_world @ basis.data[index].co
            )
            morph_displacement = (shaped - basis_point).length
            if morph_displacement > locality_epsilon:
                affected_vertices += 1
                if is_cheek_shape:
                    outside_region = (
                        original.z < mouth_center_z + scaled("cheek_lower_z")
                        or original.z > mouth_center_z + scaled("cheek_upper_z")
                        or abs(original.x - mouth_center_x) > scaled("cheek_outer_x")
                    )
                else:
                    outside_region = (
                        original.z < anatomical_min_z
                        or original.z > anatomical_max_z
                        or abs(original.x - mouth_center_x) > anatomical_max_x
                    )
                if outside_region:
                    raise RuntimeError(
                        f"{shape.name} moved vertex {index} outside the "
                        f"anatomical facial region by {morph_displacement}"
                    )
    target_vertex_limit = 12_000 if is_cheek_shape else maximum_morph_vertices
    if shape != basis and affected_vertices > target_vertex_limit:
        raise RuntimeError(
            f"{shape.name} moved {affected_vertices} vertices; expected a "
            f"face-local morph below {target_vertex_limit} vertices"
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
kept_objects = {mesh, armature, *facial_overlays}
for scene_object in list(bpy.context.scene.objects):
    if scene_object not in kept_objects:
        bpy.data.objects.remove(scene_object, do_unlink=True)
bpy.ops.object.select_all(action="DESELECT")
mesh.select_set(True)
if armature:
    armature.select_set(True)
for overlay in facial_overlays:
    overlay.select_set(True)
bpy.context.view_layer.objects.active = armature or mesh
bpy.ops.export_scene.gltf(
    filepath=output_path,
    export_format="GLB",
    use_selection=True,
    export_animations=bool(armature and original_actions),
    export_morph=True,
    export_morph_normal=False,
    export_morph_tangent=False,
    export_image_format=os.environ.get("AVATAR_EXPORT_IMAGE_FORMAT", "AUTO"),
    export_image_quality=int(os.environ.get("AVATAR_EXPORT_IMAGE_QUALITY", "90")),
    export_draco_mesh_compression_enable=(
        os.environ.get("AVATAR_EXPORT_DRACO") == "1"
    ),
    export_draco_mesh_compression_level=6,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
    export_draco_texcoord_quantization=12,
    export_draco_color_quantization=10,
    export_draco_generic_quantization=12,
)

print(
    {
        "profile": profile_name,
        "output": output_path,
        "vertices": len(mesh.data.vertices),
        "bones_preserved": len(original_bones),
        "weights_preserved": current_weights == original_weights,
        "animations_preserved": original_actions,
        "darkened_cavity_polygons": darkened_cavity_polygons,
        "visemes": [shape.name for shape in mesh.data.shape_keys.key_blocks],
    }
)
