const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-chat-images-'));
const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile};delete env.ELECTRON_RUN_AS_NODE;
const png=(w,h,color)=>require('sharp')({create:{width:w,height:h,channels:3,background:color}}).png().toBuffer();
const file=(name,w,h,color)=>png(w,h,color).then(buffer=>({name,mimeType:'image/png',buffer}));
(async()=>{
  const app=await electron.launch({executablePath:require('electron'),args:[root,'--user-data-dir='+path.join(profile,'electron')],env});
  const errors=[];
  try{
    const page=await app.firstWindow();
    page.on('pageerror',error=>errors.push(error.message));
    await page.waitForSelector('#customTemplateSelect');
    await page.locator('.nav [data-view="chat"]').click();
    await page.waitForSelector('#chatAttachButton');
    assert.equal(await page.locator('#chatAttachRow').isHidden(),true,'未选图时不显示缩略图行');

    const calls={gemini:[],openai:[]};
    await page.route('**/v1beta/models/**',async route=>{
      calls.gemini.push(route.request().postDataJSON());
      await route.fulfill({json:{candidates:[{content:{parts:[{text:'已经看到你发的图片。'}]}}]}});
    });
    await page.route('**/v1/chat/completions',async route=>{
      calls.openai.push(route.request().postDataJSON());
      await route.fulfill({json:{choices:[{message:{content:'这是纯文字回复。'}}]}});
    });

    await page.evaluate(()=>{apiKey.value='test-only';});

    // 1. 纯文字仍然正常（默认 gemini-3.8-flash 无图走 chat/completions）
    await page.locator('#chatInput').fill('先问一个问题');
    await page.locator('#chatSend').click();
    await page.waitForFunction(()=>document.querySelector('#chatStatus').textContent.includes('已使用'));
    assert.equal(calls.openai.length,1,'纯文字请求 1 次');
    assert.equal(calls.gemini.length,0,'纯文字不触发 generateContent');
    assert.equal(calls.openai[0].messages.at(-1).role,'user');
    assert.equal(calls.openai[0].messages.at(-1).content,'先问一个问题','无图时 content 仍为纯字符串');
    await page.waitForFunction(()=>document.querySelectorAll('#chatMessages .chat-message').length===2);

    // 2. 添加两张图片 → 缩略图；删除一张
    await page.locator('#chatImageFile').setInputFiles([await file('a.png',80,60,'#3366cc'),await file('b.png',60,80,'#cc6633')]);
    await page.waitForFunction(()=>document.querySelectorAll('#chatAttachList .chat-attach-item').length===2);
    assert.equal(await page.locator('#chatAttachRow').isHidden(),false);
    assert.equal((await page.locator('#chatAttachTip').textContent()).trim(),'2/4');
    assert.match(await page.locator('#chatAttachList .chat-attach-item img').first().getAttribute('src'),/\/cache-media\/references\//,'图片落到本地媒体缓存');
    await page.locator('#chatAttachList .chat-attach-remove').first().click();
    await page.waitForFunction(()=>document.querySelectorAll('#chatAttachList .chat-attach-item').length===1);
    assert.equal((await page.locator('#chatAttachTip').textContent()).trim(),'1/4');

    // 3. 文字 + 图片一起发送 → gemini generateContent 带 inlineData，气泡显示图片
    await page.locator('#chatInput').fill('看看这张图');
    await page.locator('#chatSend').click();
    await page.waitForFunction(()=>document.querySelector('#chatStatus').textContent.includes('已使用'));
    assert.equal(calls.gemini.length,1,'图片消息走 generateContent');
    const parts=calls.gemini[0].contents.at(-1).parts;
    const inline=parts.filter(part=>part.inlineData);
    assert.equal(inline.length,1,'请求里带 1 张图');
    assert.equal(inline[0].inlineData.mimeType,'image/jpeg');
    assert.ok(inline[0].inlineData.data.length>100,'图片 base64 有内容');
    assert.ok(parts.some(part=>typeof part.text==='string'&&part.text.includes('看看这张图')),'文字与图片同一条消息');
    assert.equal(await page.locator('#chatMessages .chat-message.user').last().locator('.chat-bubble-images img').count(),1,'用户气泡显示图片');
    assert.equal(await page.locator('#chatAttachRow').isHidden(),true,'发送后清空待发送图片');
    assert.match(await page.locator('.chat-session').first().textContent(),/看看这张图|先问一个问题/,'标题取自首条用户消息');

    // 3b. 换非 Gemini 模型 → chat/completions 的 image_url 多模态负载
    await page.locator('#chatModel').selectOption('gpt-5.6-sol');
    await page.locator('#chatImageFile').setInputFiles([await file('d.png',50,50,'#778899')]);
    await page.waitForFunction(()=>document.querySelectorAll('#chatAttachList .chat-attach-item').length===1);
    await page.locator('#chatInput').fill('再换一个模型看看');
    await page.locator('#chatSend').click();
    await page.waitForFunction(()=>document.querySelector('#chatStatus').textContent.includes('已使用'));
    const multimodal=calls.openai.at(-1).messages.at(-1);
    assert.ok(Array.isArray(multimodal.content),'多模态消息 content 为数组');
    const imageParts=multimodal.content.filter(part=>part.type==='image_url');
    assert.equal(imageParts.length,1,'请求里带 1 张图');
    assert.match(imageParts[0].image_url.url,/^data:image\/jpeg;base64,/,'图片以 data URL 提交');
    assert.ok(multimodal.content.some(part=>part.type==='text'&&part.text.includes('再换一个模型看看')),'文字与图片同一条消息');

    // 4. 最多 4 张：一次选 5 张只保留 4 张，满了再加给出提示
    await page.locator('#chatImageFile').setInputFiles([
      await file('c1.png',40,40,'#111111'),await file('c2.png',40,40,'#222222'),await file('c3.png',40,40,'#333333'),
      await file('c4.png',40,40,'#444444'),await file('c5.png',40,40,'#555555')]);
    await page.waitForFunction(()=>document.querySelectorAll('#chatAttachList .chat-attach-item').length===4);
    assert.equal((await page.locator('#chatAttachTip').textContent()).trim(),'4/4');
    assert.match(await page.locator('#chatStatus').textContent(),/最多只能添加 4 张图片/);
    await page.locator('#chatImageFile').setInputFiles([await file('c6.png',40,40,'#666666')]);
    await page.waitForFunction(()=>/最多只能添加 4 张图片/.test(document.querySelector('#chatStatus').textContent));
    assert.equal(await page.locator('#chatAttachList .chat-attach-item').count(),4,'超出上限时不新增');

    // 清空缩略图
    while(await page.locator('#chatAttachList .chat-attach-remove').count()){await page.locator('#chatAttachList .chat-attach-remove').first().click();}
    await page.waitForFunction(()=>document.querySelectorAll('#chatAttachList .chat-attach-item').length===0);
    assert.equal(await page.locator('#chatAttachRow').isHidden(),true);

    // 5. 刷新后历史与图片仍可见
    await page.evaluate(()=>window.workbenchState.flush());
    await page.reload();
    await page.waitForSelector('#customTemplateSelect');
    await page.locator('.nav [data-view="chat"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('#chatMessages .chat-message').length>=4);
    assert.equal(await page.locator('#chatMessages .chat-message.user').last().locator('.chat-bubble-images img').count(),1,'刷新后图片仍显示');

    // 6. 新建对话与旧对话隔离，切回旧对话图片仍在
    await page.locator('#chatNew').click();
    await page.waitForFunction(()=>document.querySelector('#chatMessages').textContent.includes('开始一段新对话'));
    assert.equal(await page.locator('#chatMessages .chat-message').count(),0,'新对话没有历史');
    assert.equal(await page.locator('#chatAttachRow').isHidden(),true,'新对话清空待发送图片');
    await page.locator('.chat-session',{hasText:'先问一个问题'}).click();
    await page.waitForFunction(()=>document.querySelectorAll('#chatMessages .chat-message').length>=4);
    assert.equal(await page.locator('#chatMessages .chat-message.user').last().locator('.chat-bubble-images img').count(),1,'切回旧对话图片仍在');

    assert.deepEqual(errors,[],'页面无 JS 报错');
    console.log('PASS: 连续聊天支持添加图片（点选/缩略图/删除/最多 4 张、Gemini inlineData 与 OpenAI image_url 负载、纯文字回归、刷新恢复、会话隔离）。上游请求全部 mock，无付费调用。');
  }finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
