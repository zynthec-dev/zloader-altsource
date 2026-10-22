import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const code=await readFile(new URL('../site/admin/ipa-upload.js',import.meta.url),'utf8');
const { uploadIPA, MAX_IPA_BYTES, IPA_CHUNK_BYTES }=await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const reads=[];
const file={size:200_000_000,slice(start,end){
 assert.equal(start,reads.length*IPA_CHUNK_BYTES);
 assert.ok(end-start<=IPA_CHUNK_BYTES);
 reads.push([start,end]);
 return new Blob([new Uint8Array(Math.min(end,this.size)-start).fill(reads.length)]);
}};
let sent=0;const progress=[];
const staged=await uploadIPA(file,async body=>{
 const bytes=Buffer.from(body.content,'base64');
 assert.equal(body.encoding,'base64');assert.ok(bytes.length<=8_000_000);
 assert.equal(bytes[0],reads.length);assert.equal(bytes.at(-1),reads.length);
 sent+=bytes.length;
 return {sha:reads.length.toString(16).padStart(40,'0')};
},(value,total)=>progress.push([value,total]));
assert.equal(sent,MAX_IPA_BYTES);assert.equal(staged.chunks.length,25);
assert.equal(staged.chunks.reduce((n,c)=>n+c.size,0),file.size);
assert.deepEqual(progress.at(-1),[file.size,file.size]);
let touched=false;
for(const size of [0,200_000_001]) await assert.rejects(uploadIPA({size,slice(){touched=true;}},()=>{touched=true;}),/200 MB/);
assert.equal(touched,false);
let uploads=0;
await assert.rejects(uploadIPA({size:9_000_000,slice:(a,b)=>new Blob([new Uint8Array(Math.min(b,9_000_000)-a)])},async()=>{
 if(++uploads===2)throw new Error('interrupted');return {sha:'a'.repeat(40)};
}),/interrupted/);
assert.equal(uploads,2);
const small=await uploadIPA(new Blob(['test ipa']),async()=>({sha:'b'.repeat(40)}));
assert.deepEqual(small,{sha:'b'.repeat(40),size:8});
console.log('PASS: exact 200 MB sliced upload, byte order, progress, oversize/empty rejection, interrupted upload and legacy small-file metadata.');
