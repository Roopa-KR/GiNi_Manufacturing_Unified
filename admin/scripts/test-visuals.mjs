import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const React=require('react'),{renderToStaticMarkup:render}=require('react-dom/server');
const dir=await mkdtemp(path.join(tmpdir(),'gini-viz-'));
try {
 for(const app of ['admin','frontend']) {
 const root=path.resolve(import.meta.dirname,'../..');
 const out=path.join(dir,app+'.cjs');
 await build({entryPoints:[path.join(root,app,'src/components/Visuals.jsx')],outfile:out,bundle:true,platform:'node',format:'cjs',external:['react']});
 const source=await import('node:fs/promises').then(fs=>fs.readFile(out,'utf8'));
 const module={exports:{}};new Function('require','module','exports',source)(require,module,module.exports);
 const {Bars,ProgressMeter,Steps,ActivityStrip}=module.exports;
 const h=React.createElement;
 const bars=render(h(Bars,{title:'Points',signed:true,rows:[{label:'Negative',value:-2.5},{label:'Positive',value:1},{label:'Unknown',value:null}]}));
 assert(bars.includes('-2.5')&&bars.includes('+1')&&bars.includes('Not recorded'));
 assert(!bars.includes('NaN')&&!bars.includes('width:-'));
 assert(render(h(Bars,{rows:[]})).includes('No recorded data'));
 assert(render(h(ProgressMeter,{label:'Done',value:12,total:10})).includes('aria-valuenow="100"'));
 assert(render(h(ProgressMeter,{label:'Unknown',value:null,total:10})).includes('Not recorded'));
 assert(render(h(ProgressMeter,{value:0,total:0})).includes('Not recorded'));
 assert(render(h(Steps,{title:'Route',steps:[{label:'WC1',done:true},{label:'WC2',current:true}]})).includes('class="current"'));
 assert(render(h(ActivityStrip,{events:[],time:x=>x})).includes('No events recorded'));
 console.log(`${app}: 8 visual regression assertions passed`);
 }
} finally {await rm(dir,{recursive:true,force:true});}
