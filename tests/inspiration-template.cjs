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
  await page.evaluate(()=>{const transfer=new DataTransfer(),source=document.querySelector('.task .result img'),target=document.querySelector('#workspaceView .panel');if(!source)throw new Error('generated result image not found');source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));if(transfer.getData('application/x-ai-workbench-task-key')!==tasks[0].key)throw new Error('task key was not attached to dragged image');target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));});
  await page.waitForFunction(()=>!workspaceView.hidden&&selectedCustomTemplateKey==='custom-inspiration-template');
  assert.equal(await page.locator('#fields textarea').first().inputValue(),'模板中的人物内容');
  await page.locator('.nav [data-view="assets"]').click();
  await page.locator('[data-asset-action="inspiration"]').click();
  await page.locator('.nav [data-view="inspiration"]').click();
  await page.locator('[data-inspiration-action="use"]').dispatchEvent('click');
  await page.waitForFunction(()=>!workspaceView.hidden);
  assert.equal(await page.evaluate(()=>type),'person');
  assert.equal(await page.evaluate(()=>selectedCustomTemplateKey),'custom-inspiration-template');
  assert.equal(await page.locator('#fields textarea').first().inputValue(),'模板中的人物内容');
  assert.equal(await page.evaluate(()=>refs.length),10);
  const importedMeta=await page.evaluate(async pixel=>{await importInspirationFile(new Blob([JSON.stringify({inspirations:[{url:'data:image/png;base64,imported-'+pixel,title:'导入模板灵感',prompt:'模板中的人物内容',type:'person',values:{'人物特征':'导入的人物内容'},fieldNames:{'人物特征':'人物特征'},selectedCustomTemplateKey:'custom-inspiration-template',category:'图片生成'}]})],{type:'application/json'}));const item=importedInspirations.find(entry=>entry.title==='导入模板灵感');return {type:item?.type,value:item?.values?.['人物特征'],template:item?.selectedCustomTemplateKey};},PIXEL);
  assert.deepEqual(importedMeta,{type:'person',value:'导入的人物内容',template:'custom-inspiration-template'});
  await page.evaluate(pixel=>{importedInspirations=[{key:'legacy-blank',url:'data:image/png;base64,'+pixel,title:'旧版纯提示词灵感',prompt:'一只猫坐在窗边，柔和自然光',category:'图片生成'}];assets=[];saveImportedInspirations();renderInspiration();activateView('inspiration');},PIXEL);
  await page.locator('[data-inspiration-action="use"]').dispatchEvent('click');
  await page.waitForFunction(()=>!workspaceView.hidden);
  assert.equal(await page.evaluate(()=>type),'blank');
  assert.equal(await page.locator('#blankPrompt').inputValue(),'一只猫坐在窗边，柔和自然光');
  console.log('PASS: 使用灵感可恢复自定义模板，旧版无模板元数据的纯提示词灵感恢复为空白模板。');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
