const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'workbench-prompt-expand-'));
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

    const longPrompt = Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行提示词：展开后应立即留在当前任务卡片。`).join('\n');
    await page.evaluate(prompt => {
      tasks = Array.from({ length: 40 }, (_, index) => ({
        key: index === 24 ? 'expand-target' : index === 35 ? 'expand-lower-target' : `expand-other-${index}`,
        prompt: index === 24 || index === 35 ? prompt : `其他任务 ${index}`,
        model: 'test-model', size: '2K', ratio: '1:1', status: 'succeeded', refs: [], createdAt: Date.now() - index
      }));
      renderTasks();
    }, longPrompt);

    const target = page.locator('#list .task[data-key="expand-target"]');
    await target.waitFor();
    const before = await page.evaluate(() => {
      const pane = document.querySelector('.tasks');
      const card = document.querySelector('#list .task[data-key="expand-target"]');
      pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top - 24;
      window.__promptExpandTarget = card;
      return { scrollTop: pane.scrollTop, cardTop: card.getBoundingClientRect().top };
    });
    assert.ok(await target.locator('.prompt').evaluate(node => node.scrollHeight > node.clientHeight + 1), '长提示词默认应折叠');

    await target.locator('.expand').click();
    const after = await page.evaluate(() => {
      const pane = document.querySelector('.tasks');
      const card = document.querySelector('#list .task[data-key="expand-target"]');
      return {
        sameCard: card === window.__promptExpandTarget,
        scrollTop: pane.scrollTop,
        cardTop: card.getBoundingClientRect().top,
        promptOpen: card.querySelector('.prompt').classList.contains('open'),
        buttonText: card.querySelector('.expand').textContent.trim(),
        promptHeight: card.querySelector('.prompt').clientHeight,
        promptScrollHeight: card.querySelector('.prompt').scrollHeight
      };
    });
    assert.equal(after.sameCard, true, '展开提示词不应重建整张任务卡片');
    assert.equal(after.scrollTop, before.scrollTop, '展开后任务列表滚动位置应保持不变');
    assert.equal(after.cardTop, before.cardTop, '展开后视口应仍停留在当前任务');
    assert.equal(after.promptOpen, true);
    assert.equal(after.buttonText, '收起');
    assert.ok(after.promptScrollHeight <= after.promptHeight + 1, '展开后应完整显示提示词');

    const lowerTarget = page.locator('#list .task[data-key="expand-lower-target"]');
    await lowerTarget.waitFor();
    const lowerBefore = await page.evaluate(() => {
      const pane = document.querySelector('.tasks');
      const card = document.querySelector('#list .task[data-key="expand-lower-target"]');
      pane.scrollTop += card.getBoundingClientRect().top - (pane.getBoundingClientRect().top + pane.clientHeight - 140);
      return { scrollTop: pane.scrollTop };
    });
    await page.waitForTimeout(300);
    const expandButton = lowerTarget.locator('.expand');
    const buttonVisible = await expandButton.evaluate(node => {
      const pane = node.closest('.tasks'), paneRect = pane.getBoundingClientRect(), rect = node.getBoundingClientRect();
      return rect.top >= paneRect.top && rect.bottom <= paneRect.bottom;
    });
    assert.equal(buttonVisible, true, '底部任务的展开按钮应在点击前可见');
    await expandButton.click();
    const lowerAfter = await page.evaluate(() => {
      const pane = document.querySelector('.tasks');
      const prompt = document.querySelector('#list .task[data-key="expand-lower-target"] .prompt');
      const paneRect = pane.getBoundingClientRect(), promptRect = prompt.getBoundingClientRect();
      return { scrollTop: pane.scrollTop, promptTop: promptRect.top, promptBottom: promptRect.bottom, paneTop: paneRect.top, paneBottom: paneRect.bottom };
    });
    assert.ok(lowerAfter.scrollTop > lowerBefore.scrollTop, '提示词超出列表底部时应只滚动必要距离');
    assert.ok(lowerAfter.promptTop >= lowerAfter.paneTop, '滚动后提示词开头应可见');
    assert.ok(lowerAfter.promptBottom <= lowerAfter.paneBottom, '滚动后展开提示词应完整可见');
    assert.deepEqual(errors, []);
    console.log('PASS: 长任务列表中展开提示词后仍停留在当前卡片，列表滚动位置不变。');
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
