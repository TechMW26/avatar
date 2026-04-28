// Polyfills for FBXLoader in node
global.self = global;
global.window = global;
function makeImg() {
  return {
    addEventListener(){}, removeEventListener(){},
    set src(_) {}, get src(){return '';},
    crossOrigin: '',
  };
}
global.document = {
  createElement: (tag) => tag === 'img' ? makeImg() : { getContext: () => null },
  createElementNS: (_ns, tag) => tag === 'img' ? makeImg() : makeImg(),
};
global.Image = function() { return makeImg(); };
global.Blob = class {};
global.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
global.HTMLCanvasElement = class {};
global.HTMLImageElement = class {};
global.OffscreenCanvas = class {};

const fs = require('fs');
const path = require('path');
const THREE = require('three');
const { FBXLoader } = require('three-stdlib');

async function inspect(file) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const loader = new FBXLoader();
  let group;
  try {
    group = loader.parse(ab, '');
  } catch (e) {
    console.log('==', path.basename(file), 'PARSE-ERR:', e.message);
    return;
  }
  const bones = [];
  group.traverse((o) => { if (o.isBone) bones.push(o.name); });
  console.log('==', path.basename(file));
  console.log('bones:', bones.length);
  console.log(bones.slice(0, 80).join(', '));
  console.log('animations:', group.animations.map(a => `${a.name}(d=${a.duration.toFixed(2)}, tracks=${a.tracks.length})`));
  if (group.animations[0]) {
    console.log('sample track names:', group.animations[0].tracks.slice(0,8).map(t => t.name));
  }
}

(async () => {
  for (const f of process.argv.slice(2)) {
    try { await inspect(f); } catch (e) { console.error(f, e.message); }
  }
})();
