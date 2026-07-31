"""Render a front-view GLB preview for visual QA."""

import os
import sys
import math

import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) not in (2, 3, 4, 5, 6):
    raise SystemExit(
        "Expected: <model.glb> <preview.png> [shape-key] [value] [frame] [front|back]"
    )

model_path = os.path.abspath(args[0])
output_path = os.path.abspath(args[1])
shape_name = (
    None
    if len(args) < 3 or args[2].lower() in {"none", "rest"}
    else args[2]
)
shape_value = float(args[3]) if len(args) >= 4 else 1.0
preview_frame = float(args[4]) if len(args) >= 5 else None
preview_side = args[5] if len(args) == 6 else "front"
bpy.ops.wm.read_factory_settings(use_empty=True)
if model_path.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=model_path)
else:
    bpy.ops.import_scene.gltf(filepath=model_path)

armatures = [
    obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"
]
if armatures and bpy.data.actions:
    armature = armatures[0]
    if preview_frame == -1:
        armature.data.pose_position = "REST"
    else:
        armature.animation_data_create()
        armature.animation_data.action = next(
            (
                action
                for action in bpy.data.actions
                if "rigify_clip" in action.name
            ),
            sorted(bpy.data.actions, key=lambda action: action.name)[0],
        )
        start, end = armature.animation_data.action.frame_range
        bpy.context.scene.frame_set(
            int(min(max(start, preview_frame), end))
            if preview_frame is not None
            else int(min(start + 20, end))
        )

meshes = [
    obj
    for obj in bpy.context.scene.objects
    if (
        obj.type == "MESH"
        and len(obj.data.vertices) > 100
        and obj.visible_get()
        and not obj.hide_render
    )
]
if not meshes:
    raise RuntimeError("No mesh found")

for mesh in meshes:
    mesh.select_set(True)
    if shape_name and mesh.data.shape_keys:
        shape = mesh.data.shape_keys.key_blocks.get(shape_name)
        if shape:
            shape.value = shape_value
bpy.context.view_layer.objects.active = meshes[0]

bounds = [
    mesh.matrix_world @ Vector(corner)
    for mesh in meshes
    for corner in mesh.bound_box
]
minimum = Vector(tuple(min(point[index] for point in bounds) for index in range(3)))
maximum = Vector(tuple(max(point[index] for point in bounds) for index in range(3)))
center = (minimum + maximum) * 0.5
height = maximum.z - minimum.z
if shape_name:
    center.z = maximum.z - height * 0.14

camera_data = bpy.data.cameras.new("PreviewCamera")
camera = bpy.data.objects.new("PreviewCamera", camera_data)
bpy.context.collection.objects.link(camera)
if preview_side == "back":
    camera.location = Vector((center.x, maximum.y + 4.0, center.z))
elif preview_side == "left":
    camera.location = Vector((minimum.x - 4.0, center.y, center.z))
elif preview_side == "right":
    camera.location = Vector((maximum.x + 4.0, center.y, center.z))
elif preview_side.startswith("angle:"):
    angle = math.radians(float(preview_side.split(":", 1)[1]))
    camera.location = Vector(
        (
            center.x + math.sin(angle) * 4.0,
            center.y - math.cos(angle) * 4.0,
            center.z,
        )
    )
else:
    camera.location = Vector((center.x, minimum.y - 4.0, center.z))
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = height * (0.34 if shape_name else 1.08)
bpy.context.scene.camera = camera

for x in (-2.5, 2.5):
    light_data = bpy.data.lights.new(f"Key{x}", "AREA")
    light_data.energy = 900
    light_data.shape = "DISK"
    light_data.size = 4.0
    light = bpy.data.objects.new(f"Key{x}", light_data)
    bpy.context.collection.objects.link(light)
    light.location = Vector((x, minimum.y - 2.5, maximum.z + 1.5))
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("PreviewWorld")
world.color = (0.035, 0.035, 0.035)
bpy.context.scene.world = world

scene = bpy.context.scene
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 700
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = output_path
scene.render.film_transparent = False
scene.view_settings.look = "AgX - Medium High Contrast"
bpy.ops.render.render(write_still=True)
print({"preview": output_path, "bounds": [tuple(minimum), tuple(maximum)]})
