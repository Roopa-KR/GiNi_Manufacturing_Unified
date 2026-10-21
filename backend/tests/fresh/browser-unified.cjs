const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');
const { MongoClient } = require('mongodb');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,args:['--no-sandbox']});
 const errors=[], rows=[];const dbclient=new MongoClient(process.env.MONGODB_URI);await dbclient.connect();const db=dbclient.db(process.env.MONGODB_DB_NAME);
 try {
 async function pageFor(url,login,pin){const ctx=await browser.newContext({viewport:{width:1440,height:950}});const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await p.locator('#lid').fill(login);await p.locator('#pin').fill(pin);await p.getByRole('button',{name:'Sign in',exact:true}).click();await p.locator('#lid').waitFor({state:'detached',timeout:15000});return p;}
 const p=await pageFor(process.env.ADMIN_URL,process.env.ADMIN_LOGIN,process.env.ADMIN_PASSWORD);
 for(const path of ['/','/setup','/dispatch','/orders','/work-centers','/workforce','/quality','/alerts','/recovery','/verify','/materials','/admin']){
  await p.goto(process.env.ADMIN_URL+path);await p.locator('.page').first().waitFor({timeout:15000});await p.waitForTimeout(400);const text=await p.locator('body').innerText();assert.ok(!text.includes('Something went wrong'),path);assert.ok(text.length>150,path);rows.push({role:'admin',path,status:'PASS'});
 }
 const tank=await db.collection('sim_units').findOne({STATE:'ROUTE_COMPLETE'});
 await p.goto(process.env.ADMIN_URL+'/units/'+tank.UNIT_ID);await p.getByText('Tank passport').first().waitFor({timeout:15000});rows.push({role:'admin',path:'tank passport',status:'PASS'});
 const op=await pageFor(process.env.FRONTEND_URL,'ana.test','246810');
 for(const path of ['/','/queue','/progress','/profile']){await op.goto(process.env.FRONTEND_URL+path);await op.locator('.page').first().waitFor({timeout:15000});await op.waitForTimeout(400);assert.ok((await op.locator('body').innerText()).length>150);rows.push({role:'operator',path,status:'PASS'});}
 const inspector=await pageFor(process.env.FRONTEND_URL,'jacob.quality','765432');await inspector.locator('.page').first().waitFor({timeout:15000});rows.push({role:'inspector',path:'Work',status:'PASS'});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({rows,jsErrors:errors},null,2));
 }finally{await browser.close();await dbclient.close();}
})().catch(e=>{console.error(e);process.exit(1)});
