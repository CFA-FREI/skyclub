import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const names = ['index.html', 'app.js', 'style.css', 'favicon.svg'];
const results = names.map(name => {
  const raw = fs.readFileSync(path.join(publicDir, name));
  const brotli = zlib.brotliCompressSync(raw, {params:{[zlib.constants.BROTLI_PARAM_QUALITY]:5}});
  const gzip = zlib.gzipSync(raw, {level:6});
  return {fichier:name, original:raw.length, brotli:brotli.length, gzip:gzip.length, gain:`${(100*(raw.length-brotli.length)/raw.length).toFixed(1)} %`};
});
console.table(results);
const raw=results.reduce((n,r)=>n+r.original,0);
const br=results.reduce((n,r)=>n+r.brotli,0);
console.log(`Transfert initial (fichiers statiques) : ${raw} → ${br} octets, soit ${(100*(1-br/raw)).toFixed(1)} % de réduction Brotli.`);
console.log('Les visites ultérieures reçoivent des réponses 304 si les fichiers n’ont pas changé.');
