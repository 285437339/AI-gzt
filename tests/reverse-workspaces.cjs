const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-reverse-workspaces-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;

async function imageBuffer(background) {
  return sharp({ create: { width: 48, height: 36, channels: 3, background } }).png().toBuffer();
}

(async () => {
  const app = await electron.launch({
    executablePath: process.env.WORKBENCH_TEST_EXE || require('electron'),
    args: [...(process.env.WORKBENCH_TEST_EXE ? [] : [root]), '--user-data-dir=' + path.join(profile, 'electron')],
    env
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#customTemplateSelect');
    await page.locator('.nav [data-view="reverse"]').click();
    await page.waitForSelector('#reverseView:not([hidden])');

    const tabs = page.locator('#reverseWorkspaceTabs .canvas-workspace-tab');
    assert.equal(await tabs.count(), 1, '默认应只有一个反推工作区');
    assert.match(await tabs.first().innerText(), /提示词 1/);

    const chooseDifferentModel = async () => page.locator('#reverseModel').evaluate(node => {
      const values = [...node.options].map(option => option.value).filter(Boolean);
      const next = values.find(value => value !== node.value) || node.value;
      node.value = next;
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return next;
    });

    // 工作区 A：指令、模板、模型、结果和参考图。
    await page.locator('#reverseTemplateSelect').selectOption('builtin:1');
    await page.locator('#reverseInstruction').fill('工作区 A：重点描述银灰色产品材质');
    const modelA = await chooseDifferentModel();
    await page.locator('#reverseResult').evaluate(node => {
      node.textContent = '工作区 A 的反推结果';
      node.classList.remove('empty');
    });
    await page.locator('#reverseCopy').evaluate(node => { node.disabled = false; });
    await page.locator('#reverseFile').setInputFiles({
      name: 'workspace-a.png', mimeType: 'image/png', buffer: await imageBuffer('#aa5522')
    });
    await page.waitForFunction(() => reverseRefs[0]?.startsWith('/cache-media/'));
    await page.waitForTimeout(450);

    // 工作区 B：新建后不应携带 A 的指令或结果，并保存自己的内容与参考图。
    await page.locator('#reverseNewWorkspace').click();
    await page.waitForTimeout(250);
    assert.equal(await tabs.count(), 2, '新建后应有两个工作区');
    assert.match(await tabs.nth(1).innerText(), /提示词 2/);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '', '新工作区不应携带 A 的补充要求');
    assert.equal((await page.locator('#reverseResult').textContent()).trim(), '上传至少一张参考图，然后点击“开始反推”');
    assert.equal(await page.locator('#reverseSlots img').count(), 0, '新工作区不应携带 A 的参考图');

    await page.locator('#reverseInstruction').fill('工作区 B：强调暖色氛围光');
    const modelB = await chooseDifferentModel();
    await page.locator('#reverseResult').evaluate(node => {
      node.textContent = '工作区 B 的反推结果';
      node.classList.remove('empty');
    });
    await page.locator('#reverseCopy').evaluate(node => { node.disabled = false; });
    await page.locator('#reverseFile').setInputFiles({
      name: 'workspace-b.png', mimeType: 'image/png', buffer: await imageBuffer('#2277aa')
    });
    await page.waitForFunction(() => reverseRefs[0]?.startsWith('/cache-media/'));
    await page.waitForTimeout(450);

    // 切回 A：A 的所有字段和参考图都应恢复，而不受 B 影响。
    await tabs.first().locator('span').first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '工作区 A：重点描述银灰色产品材质');
    assert.equal(await page.locator('#reverseModel').inputValue(), modelA);
    assert.equal(await page.locator('#reverseTemplateSelect').inputValue(), 'builtin:1');
    assert.equal((await page.locator('#reverseResult').textContent()).trim(), '工作区 A 的反推结果');
    assert.equal(await page.locator('#reverseCopy').isDisabled(), false);
    assert.equal(await page.locator('#reverseSlots img').count(), 1, '切回 A 应恢复 A 的参考图');

    // 切回 B：确认双向隔离。
    await tabs.nth(1).locator('span').first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '工作区 B：强调暖色氛围光');
    assert.equal(await page.locator('#reverseModel').inputValue(), modelB);
    assert.equal((await page.locator('#reverseResult').textContent()).trim(), '工作区 B 的反推结果');
    assert.equal(await page.locator('#reverseSlots img').count(), 1, '切回 B 应恢复 B 的参考图');

    // 刷新后应恢复两个工作区及当前工作区 B 的内容。
    await page.reload();
    await page.waitForSelector('#customTemplateSelect');
    await page.locator('.nav [data-view="reverse"]').click();
    await page.waitForSelector('#reverseView:not([hidden])');
    assert.equal(await tabs.count(), 2, '刷新后应保留两个工作区');
    assert.match(await tabs.nth(1).innerText(), /提示词 2/);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '工作区 B：强调暖色氛围光');
    assert.equal(await page.locator('#reverseModel').inputValue(), modelB);
    assert.equal((await page.locator('#reverseResult').textContent()).trim(), '工作区 B 的反推结果');
    assert.equal(await page.locator('#reverseSlots img').count(), 1, '刷新后应恢复 B 的参考图');

    await tabs.first().locator('span').first().click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '工作区 A：重点描述银灰色产品材质');
    assert.equal(await page.locator('#reverseSlots img').count(), 1, '刷新后切回 A 仍应恢复 A 的参考图');

    // 关闭非活动 A，当前 B 继续保留。
    await tabs.first().locator('[data-reverse-close]').click();
    await page.waitForTimeout(250);
    assert.equal(await tabs.count(), 1, '关闭非活动工作区后应剩一个');
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '工作区 B：强调暖色氛围光');

    // 只剩一个时点击关闭会重置该工作区，而不是移除标签。
    await tabs.first().locator('[data-reverse-close]').click();
    await page.waitForTimeout(250);
    assert.equal(await tabs.count(), 1, '最后一个工作区关闭后仍应保留一个标签');
    assert.match(await tabs.first().innerText(), /提示词 1/);
    assert.equal(await page.locator('#reverseInstruction').inputValue(), '');
    assert.equal(await page.locator('#reverseSlots img').count(), 0);
    assert.equal((await page.locator('#reverseResult').textContent()).trim(), '上传至少一张参考图，然后点击“开始反推”');

    assert.deepEqual(errors, [], '页面不应有脚本错误：' + JSON.stringify(errors));
    console.log('PASS: 提示词反推多工作区独立保存指令、模板、模型、结果与参考图；关闭和刷新恢复均正常。Profile: ' + profile);
  } finally {
    await app.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});