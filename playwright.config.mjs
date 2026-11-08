import {defineConfig} from '@playwright/test';
const origin=`http://127.0.0.1:${process.env.WRAPPER_PORT??4173}`;
export default defineConfig({testDir:'./tests',testMatch:'*.spec.mjs',timeout:60000,workers:1,use:{baseURL:origin,headless:true},webServer:{command:'node scripts/serve.mjs',url:origin,reuseExistingServer:false,timeout:15000}});
