const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-tutorials-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;

(async () => {
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [root, '--user-data-dir=' + path.join(profile, 'electron')],
    env
  });
  try {
    const page = await app.firstWindow();
    const nav = page.locator('.nav [data-view="tutorials"]');
    const tutorials = page.locator('#tutorialsView');
    const creationMenu = page.locator('#creationToolsNavTitle');
    await creationMenu.waitFor();
    assert.equal(await nav.evaluate(button => button.nextElementSibling.dataset.view), 'settings');
    assert.equal(await tutorials.isHidden(), true);
    await creationMenu.click();
    assert.equal(await creationMenu.getAttribute('aria-expanded'), 'false');
    await nav.click();
    await tutorials.waitFor();
    assert.equal(await page.locator('#workspaceView').isHidden(), true);
    assert.equal(await page.locator('.top span b').textContent(), '教程');
    const lessons = tutorials.locator('.tutorial-list > details > summary');
    assert.deepEqual(await lessons.allTextContents(), [
      '首次配置',
      '产品人像生图：首次出图与同场景换姿势',
      '图片生成模板：选择、编辑与复用'
    ]);

    const workflow = tutorials.locator('#consistentImageTutorial');
    const workflowSummary = workflow.locator(':scope > summary');
    await workflowSummary.press('Enter');
    assert.equal(await workflow.getAttribute('open'), '');
    assert.equal(await workflow.locator('h2').count(), 2);
    assert.equal(await workflow.locator('img').count(), 5);
    assert.equal(await workflow.getByRole('heading', { name: '3. 逐条自动识别并填充，再分别生图', exact: true }).count(), 1);
    assert.doesNotMatch(await workflow.textContent(), /勾选|一张姿势图对应一条提示词/);
    const firstPreview = workflow.locator('[data-tutorial-reverse-template="builtin:1"]');
    assert.equal(await workflow.locator('[data-tutorial-reverse-template="builtin:2"]').count(), 0);
    assert.match(await firstPreview.textContent(), /人物五官参考图3[\s\S]+光影与质感/);
    const firstPreviewSummary = workflow.locator('.tutorial-template-preview').filter({ has: page.locator('[data-tutorial-reverse-template="builtin:1"]') }).locator('summary');
    await firstPreviewSummary.press('Enter');
    assert.equal(await firstPreview.isVisible(), true);
    await firstPreviewSummary.press('Enter');
    const notice = workflow.locator('.tutorial-notice');
    assert.match(await notice.textContent(), /nano-banana-2/);
    assert.match(await notice.textContent(), /gpt-image-2\.5-sunburst/);
    for (const img of await workflow.locator('img').all()) {
      await img.scrollIntoViewIfNeeded();
      await img.evaluate(image => image.decode());
      assert.ok(await img.evaluate(image => image.naturalWidth > 0 && image.alt.length > 0));
    }
    await workflow.locator('[data-tutorial-target="reverse"]').first().click();
    assert.equal(await page.locator('#reverseView').isVisible(), true);
    assert.equal(await creationMenu.getAttribute('aria-expanded'), 'true');
    const reverseTemplate = page.locator('#reverseTemplateSelect');
    const reverseInstruction = page.locator('#reverseInstruction');
    await reverseTemplate.selectOption('builtin:1');
    assert.equal(await reverseInstruction.inputValue(), await firstPreview.textContent());
    const savedPrompt = '图1的围巾换成图2的围巾。\n**动作姿态**：';
    const draftPrompt = '尚未保存的反推草稿';
    await reverseInstruction.fill(savedPrompt);
    await page.locator('#saveReverseTemplate').click();
    await reverseInstruction.fill(draftPrompt);
    await nav.click();
    assert.equal(await firstPreview.textContent(), savedPrompt);
    assert.equal(await reverseInstruction.inputValue(), draftPrompt);
    assert.equal(await reverseTemplate.inputValue(), 'builtin:1');
    await workflowSummary.press('Enter');

    const templates = tutorials.locator('#imageTemplateTutorial');
    await templates.locator('summary').press('Enter');
    await templates.locator('img').scrollIntoViewIfNeeded();
    await templates.locator('img').evaluate(img => img.decode());
    assert.match(await templates.textContent(), /人物模板[\s\S]+静物模板[\s\S]+空白模板/);
    await templates.locator('[data-tutorial-target="workspace"]').click();
    assert.equal(await page.locator('#workspaceView').isVisible(), true);
    await nav.click();
    await templates.locator('summary').press('Enter');

    await lessons.first().press('Enter');
    await tutorials.getByRole('button', { name: '打开设置' }).click();
    assert.equal(await tutorials.isHidden(), true);
    assert.equal(await page.locator('#settingsView').isVisible(), true);
    assert.equal(await page.locator('.nav button.on').getAttribute('data-view'), 'settings');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.view), 'settings');
    await nav.click();
    await page.setViewportSize({ width: 760, height: 880 });
    await workflowSummary.press('Enter');
    const gallery = workflow.locator('.tutorial-model-examples');
    assert.equal(await gallery.evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1);
    assert.equal(await tutorials.evaluate(view => view.scrollWidth <= view.clientWidth), true);
    console.log('PASS tutorials sidebar, expandable lessons, and in-app navigation');
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
