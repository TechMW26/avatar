function makeImg() { return { addEventListener(){}, removeEventListener(){}, set src(_) {}, get src(){return '';}, crossOrigin: '' }; }
global.self = global; global.window = global;
global.document = { createElement: (t)=>t==='img'?makeImg():{getContext:()=>null}, createElementNS:(_n,t)=>makeImg() };
global.Image = function(){ return makeImg(); };
global.Blob = class {}; global.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
global.HTMLCanvasElement = class {}; global.HTMLImageElement = class {}; global.OffscreenCanvas = class {};
const fs = require('fs');
const { FBXLoader } = require('three-stdlib');
const buf = fs.readFileSync(process.argv[2]);
const group = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
group.traverse((o) => {
  console.log(o.type, o.name, 'children:', o.children.length, 'isSkinned:', !!o.isSkinnedMesh, 'hasSkeleton:', !!o.skeleton, 'skinWeight:', o.geometry?.attributes?.skinWeight ? 'YES' : 'NO');
});
