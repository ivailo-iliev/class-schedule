import {test,expect} from '@playwright/test';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const release=JSON.parse(readFileSync('public/release.json'));
const skating=existsSync('public/Schedule.html');
test('immutable shared assets remain compatible and allow cross-origin SRI loading',async({request})=>{
 for(const [asset,integrity] of [[release.adminEntry,release.scriptIntegrity],[release.adminStyles,release.styleIntegrity]]){
  const response=await request.get(release.assetOrigin+asset);
  expect(response.status()).toBe(200);expect(response.headers()['access-control-allow-origin']).toBe('*');
  expect('sha384-'+createHash('sha384').update(await response.body()).digest('base64')).toBe(integrity);
 }
});
test('Apache deep link boots the real remote admin module under the frontend CSP',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const response=await page.goto(skating?'/admin/':'/access');
 expect(response.status()).toBe(200);
 expect(response.headers()['content-security-policy']).toContain(release.assetOrigin);
 await expect(page.getByRole('heading',{name:'Работно пространство',exact:true})).toBeVisible();
 await expect(page.getByText('Отворете личната си връзка за достъп',{exact:true})).toBeVisible();
 expect(errors).toEqual([]);
 const manifest=await page.locator('link[rel=manifest]').getAttribute('href');
 expect((await page.request.get(manifest)).status()).toBe(200);
 if(skating){await page.goto('/coach/?keep=1#anchor');expect(page.url()).toContain('/admin/?keep=1#anchor');}
});
test('original PWA branding, manifest paths, and worker scope survive generic hosting',async({page,context})=>{
 const profile='12345678-1234-4234-8234-123456789abc';
 await page.goto(skating?`/skater/${profile}/`:'/');
 if(skating){
  await expect(page.locator('link[rel=manifest]')).toHaveAttribute('href',`/skater/${profile}/manifest.webmanifest`);
  expect(await page.evaluate(()=>window.skaterRoute.profileId)).toBe(profile);
  const manifest=await (await page.request.get(`/skater/${profile}/manifest.webmanifest`)).json();
  expect(new URL(manifest.start_url,page.url()).pathname).toBe(`/skater/${profile}/`);
 }
 // The existing skater PWA reloads on controllerchange. Poll across that reload.
 await expect.poll(async()=>{
  try{return await page.evaluate(async()=>navigator.serviceWorker.controller?(await navigator.serviceWorker.ready).scope:null);}
  catch{return null;}
 },{timeout:30000}).toBe(new URL(page.url()).origin+'/');
 const sw=await page.request.get('/sw.js');expect(sw.headers()['cache-control']).toContain('no-cache');
 if(!skating){await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'Няма връзка с интернет'})).toBeVisible();}
});
