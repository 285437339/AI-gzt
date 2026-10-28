const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-inspiration-template-'));
const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const PIXEL='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFgAI/6Kq3GAAAAAElFTkSuQmCC';

(async()=>{
 const app=await electron.launch({executablePath:require('electron'),args:[root,'--user-data-dir='+path.join(profile,'electron')],env});
 try{
  const page=await app.firstWindow();await page.waitForSelector('#customTemplateSelect');
  await page.route('**/v1/api/generate',async route=>await route.fulfill({json:{id:'inspiration-task-1',status:'running',progress:10}}));
  await page.route('**/v1/api/result*',async route=>await route.fulfill({json:{id:'inspiration-task-1',status:'succeeded',progress:100,results:[{url:'data:image/png;base64,'+PIXEL}]}}));
  await page.evaluate(()=>{apiPlatform.value='grsai';apiKey.value='test-only';customTemplates=[{key:'custom-inspiration-template',name:'测试人物模板',type:'person',values:{'人物特征':'模板中的人物内容'},fieldNames:{'人物特征':'人物特征'},refs:[]}];saveCustomTemplates();type='person';selectedCustomTemplateKey='custom-inspiration-template';renderFields({'人物特征':'模板中的人物内容'});renderCustomTemplates();});
  await page.locator('#fields textarea').first().fill('模板中的人物内容');
  await page.locator('#submit').click();
  await page.waitForFunction(()=>assets.length>0&&tasks[0]?.status==='succeeded');
  await page.locator('.nav [data-view="assets"]').click();
  await page.locator('[data-asset-action="inspiration"]').click();
  await page.locator('.nav [data-view="inspiration"]').click();
  await page.locator('[data-inspiration-action="use"]').dispatchEvent('click');
  await page.waitForFunction(()=>!workspaceView.hidden);
  assert.equal(await page.evaluate(()=>type),'person');
  assert.equal(await page.evaluate(()=>selectedCustomTemplateKey),'custom-inspiration-template');
  assert.equal(await page.locator('#fields textarea').first().inputValue(),'模板中的人物内容');
  assert.equal(await page.evaluate(()=>refs.length),10);
  console.log('PASS: 使用图片生成灵感后恢复原人物模板、字段内容和参考图槽位。');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
