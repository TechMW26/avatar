function makeImg() {
  return { addEventListener(){}, removeEventListener(){}, set src(_) {}, get src(){return '';}, crossOrigin: '' };
}
global.self = global;
global.window = global;
global.document = {
  createElement: (tag) => tag === 'img' ? makeImg() : { getContext: () => null },
  createElementNS: (_n, tag) => tag === 'img' ? makeImg() : makeImg(),
};
global.Image = function() { return makeImg(); };
global.Blob = class {};
global.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
global.HTMLCanvasElement = class {};
global.HTMLImageElement = class {};
global.OffscreenCanvas = class {};

const fs = require('fs');
const THREE = require('three');
const { FBXLoader } = require('three-stdlib');

const buf = fs.readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const group = new FBXLoader().parse(ab, '');

let totalObj = 0, skinned = 0, meshes = 0, bones = 0;
const skel = new Set();
group.traverse((o) => {
  totalObj++;
  if (o.isBone) bones++;
  if (o.isSkinnedMesh) {
    skinned++;
    if (o.skeleton) {
      o.skeleton.bones.forEach((b) => skel.add(b.name));
    }
  } else if (o.isMesh) {
    meshes++;
  }
});
console.log('totalObj', totalObj, 'meshes', meshes, 'skinned', skinned, 'bones', bones);
console.log('skeleton bone count:', skel.size);
console.log('skeleton bones:', Array.from(skel).slice(0, 80).join(', '));
console.log('animations:', group.animations.map(a => `${a.name}(d=${a.duration.toFixed(2)}, tracks=${a.tracks.length})`));

// Top-level child names
console.log('top children:', group.children.map(c => `${c.name}(${c.type})`));
