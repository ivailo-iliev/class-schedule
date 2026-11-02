import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
const read=path=>readFileSync(`public/${path}`,'utf8');
const release=JSON.parse(read('release.json'));
const skating=existsSync('public/Schedule.html');
const html=read(skating?'admin/index.html':'index.html');
test('launcher pins a compatible shared release with SRI and exact remote CSP origins',()=>{
 assert.equal(release.apiOrigin,'https://pretty-pencil.netlify.app');
 assert.match(release.assetOrigin,/^https:\/\/[a-f0-9]+--pretty-pencil\.netlify\.app$/);
 for(const [asset,integrity] of [[release.adminEntry,release.scriptIntegrity],[release.adminStyles,release.styleIntegrity]]){
  assert.ok(html.includes(release.assetOrigin+asset));assert.ok(html.includes(integrity));assert.match(integrity,/^sha384-/);
 }
 assert.ok(read('_headers').includes(release.apiOrigin));
 assert.ok(read('.htaccess').includes('RewriteEngine On'));
 assert.ok(read('_headers').includes(release.assetOrigin));
 assert.equal(release.tenantBuilds,false);
 assert.doesNotMatch(read('_redirects'),/^\/\.netlify\//m); // Netlify reserves these source paths.
 assert.match(read('_redirects'),/^\/api\/\* https:\/\/pretty-pencil\.netlify\.app\/api\/:splat 200!/m);
});
test('static distribution contains no backend, staff implementation, dependencies or privileged keys',()=>{
 for(const path of ['netlify','supabase','coach','src','calendar-importer'])assert.equal(existsSync(path),false,path);
 assert.equal(existsSync('public/admin/assets'),false);
 function walk(dir){for(const file of readdirSync(dir,{withFileTypes:true})){const path=`${dir}/${file.name}`;if(file.isDirectory())walk(path);else if(/\.(?:js|json|html|webmanifest)$/.test(path))assert.doesNotMatch(readFileSync(path,'utf8'),/sb_secret_[a-zA-Z0-9]+|SUPABASE_SECRET_API_KEY/);}}walk('public');
});
test('original install identities and same-origin workers are retained',()=>{
 const manifest=JSON.parse(read('manifest.webmanifest'));
 assert.equal(manifest.display,'standalone');assert.equal(manifest.scope,'/');
 for(const icon of manifest.icons)assert.ok(existsSync('public'+(icon.src.startsWith('/')?'':'/')+icon.src));
 assert.ok(existsSync('public/sw.js'));assert.ok(read('_headers').includes('no-cache, no-store'));
 if(skating){
  const admin=JSON.parse(read('admin/manifest.webmanifest'));assert.equal(admin.id,'/coach/');assert.equal(admin.start_url,'/admin/');
  assert.equal(manifest.start_url,'./');assert.ok(read('Schedule.html').includes('/pencil-config.js'));
  assert.match(read('_redirects'),/\/skater\/\* \/Schedule.html 200/);
 }else{assert.equal(manifest.id,'/');assert.equal(manifest.name,'График на класовете');assert.ok(read('index.html').includes('/registerSW.js'));}
});
