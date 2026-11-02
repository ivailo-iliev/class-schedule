// Run the actual generic-host .htaccess rules, without Netlify or a backend.
import {mkdtempSync,writeFileSync,rmSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'pencil-apache-'));
const binary=process.env.APACHE_BIN??'/usr/sbin/apache2';
if(!existsSync(binary))throw new Error('Install Apache 2.4 (apache2), or set APACHE_BIN.');
const modules=process.env.APACHE_MODULES??'/usr/lib/apache2/modules';
const port=Number(process.env.WRAPPER_PORT??4173);
const config=`ServerRoot "${dir}"
Listen 127.0.0.1:${port}
ServerName localhost
PidFile "${dir}/httpd.pid"
ErrorLog "${dir}/error.log"
LogLevel warn
LoadModule mpm_event_module "${modules}/mod_mpm_event.so"
LoadModule authz_core_module "${modules}/mod_authz_core.so"
LoadModule mime_module "${modules}/mod_mime.so"
LoadModule dir_module "${modules}/mod_dir.so"
LoadModule headers_module "${modules}/mod_headers.so"
LoadModule rewrite_module "${modules}/mod_rewrite.so"
TypesConfig /etc/mime.types
AddType application/manifest+json .webmanifest
AddType text/javascript .js
DocumentRoot "${resolve('dist')}"
DirectoryIndex index.html
<Directory "${resolve('dist')}">
  Require all granted
  AllowOverride All
  Options FollowSymLinks
</Directory>
`;
writeFileSync(join(dir,'httpd.conf'),config);
const child=spawn(binary,['-f',join(dir,'httpd.conf'),'-DFOREGROUND'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{if(code&&existsSync(join(dir,'error.log')))process.stderr.write(readFileSync(join(dir,'error.log')));rmSync(dir,{recursive:true,force:true});process.exit(code??0);});
