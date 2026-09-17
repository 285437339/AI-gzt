const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-dropdown-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await electron.launch({
    executablePath: process.env.WORKBENCH_TEST_EXE || require('electron'),
    args: [...(process.env.WORKBENCH_TEST_EXE ? [] : [root]), '--user-data-dir=' + path.join(profile, 'electron')], env
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#customTemplateSelect');
    await page.waitForFunction(() => document.querySelector('script[src="workbench-select.js"]'));
    const popup = page.locator('.workbench-select-popup');
    const search = page.getByRole('combobox', { name: '搜索下拉选项' });
    const open = async selector => {
      await page.locator(selector).click();
      await popup.waitFor({state: 'visible'});
    };
    const choose = async name => popup.getByRole('option', {name, exact: true}).click();

    await open('#customTemplateSelect'); await choose('人物模板');
    await page.locator('#fields textarea').first().fill('下拉框打开期间保留的内容');
    await page.waitForTimeout(500);
    const url = page.url();
    // Opening a native popup can temporarily block Chromium. A recovered
    // renderer must not be reloaded by an old unresponsive timer.
    await app.evaluate(({BrowserWindow}) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.emit('unresponsive'); contents.emit('responsive');
    });
    await page.waitForTimeout(1800);
    assert.equal(page.url(), url);
    assert.equal(await page.locator('#fields textarea').first().inputValue(), '下拉框打开期间保留的内容');

    await page.evaluate(() => {
      window.dropdownTimes = [];
      window.addEventListener('pointerdown', event => {
        if (!event.target.closest('select')) return;
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => window.dropdownTimes.push(performance.now() - start)));
      }, true);
    });
    for (let i = 0; i < 20; i++) {
      await open('#customTemplateSelect'); await search.press('Escape');
    }
    assert.equal(page.url(), url);

    // All existing change handlers still receive the original select as target.
    await open('#generationPlatform'); await choose('RunningHub 国内');
    assert.equal(await page.locator('#apiPlatform').inputValue(), 'runninghub');
    await open('#generationPlatform'); await choose('RunningHub 海外');
    assert.equal(await page.locator('#apiPlatform').inputValue(), 'runninghub-global');
    await open('#generationPlatform'); await choose('Grsai');
    await open('#model'); await choose('gpt-image-2-vip');
    assert.equal(await page.locator('#model').inputValue(), 'gpt-image-2-vip');
    await page.locator('#size').focus(); await page.locator('#size').press('ArrowDown');
    await popup.waitFor({state:'visible'}); await search.fill('2K'); await search.press('Enter');
    assert.equal(await page.locator('#size').inputValue(), '2K');

    // Disabled groups, paging, filtering, text escaping and single change event.
    await page.evaluate(() => {
      const select = document.createElement('select'); select.id = 'stressSelect';
      select.setAttribute('aria-label', '大量选项');
      select.style.cssText = 'position:fixed;top:80px;right:20px;z-index:200;width:280px';
      for (let i=0;i<2000;i++) select.add(new Option('选项 ' + i, String(i)));
      const group=document.createElement('optgroup'); group.label='不可选分组';group.disabled=true;
      group.append(new Option('禁用选项', 'disabled'));select.append(group);
      select.add(new Option('<img src=x onerror=alert(1)>', 'literal'));
      window.stressChanges=0;select.addEventListener('change',()=>window.stressChanges++);
      document.body.append(select);
    });
    await open('#stressSelect');
    assert.equal(await popup.getByRole('option').count(),60);
    await popup.getByRole('button',{name:'更多选项'}).click();
    assert.equal(await popup.getByRole('option').count(),60);
    await choose('选项 65'); assert.equal(await page.locator('#stressSelect').inputValue(),'65');
    assert.equal(await page.evaluate(()=>window.stressChanges),1);
    await open('#stressSelect'); await search.fill('禁用');
    assert.equal(await popup.getByRole('option',{name:'禁用选项'}).isDisabled(),true);
    await search.press('Enter'); assert.equal(await page.locator('#stressSelect').inputValue(),'65');
    // Selecting a disabled match may close the popup; reopen for the next case.
    if (!await popup.isVisible()) await open('#stressSelect');
    await search.fill('不存在的选项'); assert.equal(await popup.getByRole('option').count(),0);
    await search.fill('<img'); assert.equal(await popup.locator('img').count(),0);
    await search.press('Escape');

    await open('#customTemplateSelect'); await page.waitForTimeout(300);
    const draft = await page.evaluate(()=>localStorage.getItem('aiWorkbenchWorkspaceDraftV2'));
    await search.fill('人物'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(()=>localStorage.getItem('aiWorkbenchWorkspaceDraftV2')),draft);
    await page.screenshot({path:path.join(profile,'dropdown.png')});
    await search.press('Escape');
    assert.equal(await page.locator('#fields textarea').first().inputValue(),'下拉框打开期间保留的内容');

    // Dynamic controls in the canvas use the same delegated popup.
    await page.locator('.nav [data-view="canvas"]').click();
    await page.evaluate(() => {addCanvasNodeAt('model','nano-banana-2',100,100);renderCanvas();});
    const canvasSelect=page.locator('select[data-canvas-model]').first();
    await canvasSelect.click(); await popup.waitFor({state:'visible'}); await search.press('Escape');
    // Selects within dialogs must remain interactive above the modal backdrop.
    await page.evaluate(()=>{
      const dialog=document.createElement('dialog');dialog.id='qaDialog';
      dialog.innerHTML='<select id="dialogSelect"><option>A</option><option>B</option></select>';
      document.body.append(dialog);dialog.showModal();
    });
    await open('#dialogSelect'); await choose('B');
    assert.equal(await page.locator('#dialogSelect').inputValue(),'B');
    await page.evaluate(()=>document.querySelector('#qaDialog').close());
    assert.deepEqual(errors,[]);
    const times=await page.evaluate(()=>window.dropdownTimes.slice().sort((a,b)=>a-b));
    console.log('PASS: 20 repeated opens; transient stall does not reload; templates, platforms, models, keyboard, 2000 options, disabled groups, literal text, search, canvas and dialogs');
    console.log('Pointer-to-two-frames latency (ms): median=' + Math.round(times[Math.floor(times.length/2)]) + ', max=' + Math.round(times.at(-1)));
    console.log('Screenshot: '+path.join(profile,'dropdown.png'));
  } finally {await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
