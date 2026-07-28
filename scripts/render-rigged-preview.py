"""Render a prepared GLB with one of the production Mixamo animations."""

import os
import sys

import bpy
from mathutils import Quaternion, Vector

args = sys.argv[sys.argv.index("--") + 1 :]
if len(args) not in (3, 4, 5):
    raise SystemExit(
        "Expected: <model.glb> <animation.fbx> <preview.png> [frame] "
        "[limb-strength]"
    )

model_path = os.path.abspath(args[0])
animation_path = os.path.abspath(args[1])
output_path = os.path.abspath(args[2])
frame = int(args[3]) if len(args) >= 4 else 20
limb_strength = float(args[4]) if len(args) == 5 else 0.45

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=model_path)
target_armature = next(
    obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"
)
target_meshes = [
    obj
    for obj in bpy.context.scene.objects
    if obj.type == "MESH" and obj.visible_get() and not obj.hide_render
]
target_objects = set(bpy.context.scene.objects)

bpy.ops.import_scene.fbx(filepath=animation_path)
animation_objects = [
    obj for obj in bpy.context.scene.objects if obj not in target_objects
]
animation_armature = next(
    obj for obj in animation_objects if obj.type == "ARMATURE"
)
if not animation_armature.animation_data or not animation_armature.animation_data.action:
    raise RuntimeError("Animation FBX has no armature action")

scene = bpy.context.scene
action = animation_armature.animation_data.action


def stripped_bone_name(name):
    return (
        name.removeprefix("mixamorig:")
        .removeprefix("mixamorig_")
        .removeprefix("mixamorig")
    )


# The prepared characters retain the production rig's exact bind skeleton.
# Copy the sampled source pose by semantic bone name so this render exercises
# the same rotations as Avatar3D's runtime clip mapper.
source_base_rotation = {
    stripped_bone_name(bone.name): Quaternion()
    for bone in animation_armature.pose.bones
}
scene.frame_set(frame)
source_pose = {
    stripped_bone_name(bone.name): bone
    for bone in animation_armature.pose.bones
}
limited_limbs = {
    "LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand",
    "RightShoulder", "RightArm", "RightForeArm", "RightHand",
}
limited_torso = {"Spine", "Spine1", "Spine2", "Neck"}
limited_head = {"Head"}
for bone in target_armature.pose.bones:
    stripped_name = stripped_bone_name(bone.name)
    source_bone = source_pose.get(stripped_name)
    if source_bone:
        _location, rotation, scale = source_bone.matrix_basis.decompose()
        if (
            stripped_name in limited_limbs
            or stripped_name in limited_torso
            or stripped_name in limited_head
        ):
            strength = (
                limb_strength
                if stripped_name in limited_limbs
                else 0.0
                if stripped_name in limited_head
                else 0.65
            )
            rotation = source_base_rotation[stripped_name].slerp(
                rotation,
                strength,
            )
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = rotation
        bone.scale = scale
for obj in animation_objects:
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
bounds = []
for mesh in target_meshes:
    evaluated = mesh.evaluated_get(depsgraph)
    evaluated_mesh = evaluated.to_mesh()
    bounds.extend(
        evaluated.matrix_world @ vertex.co
        for vertex in evaluated_mesh.vertices
    )
    evaluated.to_mesh_clear()
minimum = Vector(tuple(min(point[index] for point in bounds) for index in range(3)))
maximum = Vector(tuple(max(point[index] for point in bounds) for index in range(3)))
center = (minimum + maximum) * 0.5
height = maximum.z - minimum.z

camera_data = bpy.data.cameras.new("RigPreviewCamera")
camera = bpy.data.objects.new("RigPreviewCamera", camera_data)
bpy.context.collection.objects.link(camera)
camera.location = Vector((center.x, minimum.y - 4.0, center.z))
camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
camera_data.type = "ORTHO"
camera_data.ortho_scale = height * 1.08
scene.camera = camera

for x in (-2.5, 2.5):
    light_data = bpy.data.lights.new(f"RigKey{x}", "AREA")
    light_data.energy = 900
    light_data.shape = "DISK"
    light_data.size = 4.0
    light = bpy.data.objects.new(f"RigKey{x}", light_data)
    bpy.context.collection.objects.link(light)
    light.location = Vector((x, minimum.y - 2.5, maximum.z + 1.5))
    light.rotation_euler = (center - light.location).to_track_quat("-Z", "Y").to_euler()

world = bpy.data.worlds.new("RigPreviewWorld")
world.color = (0.035, 0.035, 0.035)
scene.world = world
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 700
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = output_path
scene.view_settings.look = "AgX - Medium High Contrast"
bpy.ops.render.render(write_still=True)
print(
    {
        "preview": output_path,
        "frame": frame,
        "action": action.name,
        "bounds": [tuple(minimum), tuple(maximum)],
    }
)
