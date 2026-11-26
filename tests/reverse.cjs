const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-reverse-'));
const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile};delete env.ELECTRON_RUN_AS_NODE;
(async()=>{
 const app=await electron.launch({executablePath:require('electron'),args:[root,'--user-data-dir='+path.join(profile,'electron')],env});
 try{
  const page=await app.firstWindow();await page.waitForSelector('#customTemplateSelect');
  const source=await require('sharp')({create:{width:80,height:60,channels:3,background:'#aa5522'}}).png().toBuffer();
  await page.locator('.nav [data-view="workspace"]').click();
  await page.locator('#generationPlatform').selectOption('runninghub-global');
  assert.equal(await page.locator('#apiPlatform').inputValue(),'runninghub-global');
  await page.locator('.nav [data-view="reverse"]').click();
  await page.locator('#reversePlatform').selectOption('grsai');
  assert.equal(await page.locator('#generationPlatform').inputValue(),'runninghub-global');
  assert.deepEqual(await page.locator('#reverseModel option').evaluateAll(options=>options.map(option=>option.value)),
   ['gemini-3.8-flash','gpt-6.2-astra','gpt-6.2-sol','gpt-6-astra']);
  await page.locator('#reverseFile').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:source});
  await page.waitForFunction(()=>reverseRefs[0]?.startsWith('/cache-media/'));
  await page.locator('#reverseModel').selectOption('gpt-6.2-astra');
  await page.evaluate(()=>{apiKey.value='test-only';});
  let requests=0;
  await page.route('**/v1/chat/completions',async route=>{
   requests++;
   const payload=route.request().postDataJSON();
   assert.equal(payload.model,'gpt-6.2-astra');
   const images=payload.messages[0].content.filter(part=>part.type==='image_url');
   assert.equal(images.length,1);
   assert.match(images[0].image_url.url,/^data:image\/jpeg;base64,/);
   await route.fulfill({json:{choices:[{message:{content:'测试反推成功'}}]}});
  });
  await page.route('**/v1beta/models/**',async route=>{
   requests++;
   assert.match(route.request().url(),/\/v1beta\/models\/gemini-3\.8-flash:generateContent$/);
   const headers=route.request().headers();
   assert.equal(headers.authorization,'Bearer test-only');
   assert.equal(headers['x-goog-api-key'],undefined);
   const payload=route.request().postDataJSON();
   const images=payload.contents[0].parts.filter(p=>p.inlineData);
   assert.equal(images.length,1);assert.equal(images[0].inlineData.mimeType,'image/jpeg');assert.ok(images[0].inlineData.data.length>100);
   await route.fulfill({json:{candidates:[{content:{parts:[{text:'测试反推成功'}]}}]}});
  });
  await page.locator('#reverseSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#reverseStatus').textContent.includes('反推完成'));
  assert.equal(requests,1);
  await page.evaluate(()=>window.workbenchState.flush());
  await page.reload();await page.waitForSelector('#customTemplateSelect');
  await page.locator('.nav [data-view="reverse"]').click();
  await page.locator('#reverseModel').selectOption('gemini-3.8-flash');
  await page.evaluate(()=>{apiKey.value='test-only';});
  await page.locator('#reverseSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#reverseStatus').textContent.includes('反推完成'));
  assert.equal(requests,2);
  await page.reload();await page.waitForSelector('#customTemplateSelect');
  assert.equal(await page.locator('#generationPlatform').inputValue(),'runninghub-global');
  assert.equal(await page.locator('#reversePlatform').inputValue(),'grsai');
  await page.locator('.nav [data-view="reverse"]').click();
  await page.evaluate(()=>{apiKey.value='test-only';reverseRefs=['/cache-media/references/missing.png'];});
  await page.locator('#reverseSubmit').click();
  await page.waitForFunction(()=>document.querySelector('#reverseStatus').textContent.includes('本地图片读取失败'));
  assert.equal(requests,2);
  await page.evaluate(()=>{reverseRefs=[];});await page.locator('#reverseSubmit').click();
  assert.match(await page.locator('#reverseStatus').textContent(),/请先上传至少/);
  console.log('PASS GRS model list, Astra image_url, Gemini inlineData, reload reuse, missing file and empty input. Model requests mocked; no paid calls.');
 }finally{await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
