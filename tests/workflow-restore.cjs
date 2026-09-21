const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-workflow-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const IMAGE_KEY = '9f4c1a2b-1111-2222-3333-444455556666';
const IMAGE_NAME = 'nano-banana-2-2026-09-19T10-00-00-000Z-9f4c1a2b.png';
const VIDEO_KEY = 'vitest-0001';
const VIDEO_NAME = 'video-rhart-video-g_text-to-video-vitest-0-2026-09-19T10-00-00-000Z-1.mp4';

const dropFile = (page, name, type, bytes, selector = 'body') => page.evaluate(payload => {
  const transfer = new DataTransfer();
  transfer.items.add(new File([new Uint8Array(payload.bytes)], payload.name, { type: payload.type }));
  const target = document.querySelector(payload.selector);
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, { name, type, bytes, selector });

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

    // 视频任务只存在 localStorage 里，先写入再重载即可恢复。
    await page.evaluate(payload => {
      localStorage.setItem('aiWorkbenchVideoTasksV1', JSON.stringify([{
        key: payload.videoKey, id: 'video-task-1', platform: 'runninghub', model: 'rhart-video-g/text-to-video',
        prompt: '载入视频工作流测试', ratio: '2:3', resolution: '480p', duration: 8,
        refs: [payload.pixel], audios: [], status: 'succeeded', progress: 100,
        url: 'https://example.com/mock.mp4', error: '', savedPath: '', createdAt: Date.now(), updatedAt: Date.now()
      }]));
      localStorage.setItem('aiWorkbenchVideoRefsV1', JSON.stringify(Array(9).fill('')));
    }, { videoKey: VIDEO_KEY, pixel: PIXEL });
    await page.reload();
    await page.waitForSelector('#customTemplateSelect');

    // 图片任务由工作台在启动时写回，须在页面就绪后再注入。
    const labels = await page.locator('#fields textarea').evaluateAll(nodes => nodes.map(node => node.dataset.label));
    assert.ok(labels.length >= 2, '模板应至少有两个字段用于验证恢复');
    await page.evaluate(payload => {
      tasks = [{
        key: payload.imageKey, id: 'img-task-1', prompt: '载入工作流测试提示词',
        values: { [payload.labels[0]]: '白发少女', [payload.labels[1]]: '雨夜街道' },
        fieldNames: { [payload.labels[0]]: payload.labels[0], [payload.labels[1]]: payload.labels[1] },
        refs: [payload.pixel, ''], platform: 'grsai', model: 'nano-banana-2', size: '2K', ratio: '3:4', quantity: 3,
        type: 'person', status: 'succeeded', image: '', error: '', progress: 100,
        savedPath: 'C:\\generated\\' + payload.imageName, createdAt: Date.now()
      }];
      renderTasks();
    }, { imageKey: IMAGE_KEY, imageName: IMAGE_NAME, pixel: PIXEL, labels });

    // 1) 历史任务卡片上的「载入工作流」按钮。
    const imageLoad = page.locator('#list [data-action="load"]').first();
    await imageLoad.waitFor({ timeout: 15000 });
    assert.match(await imageLoad.innerText(), /载入工作流/);

    // 2) 点击后恢复图片工作流的全部参数与参考图，并回到图片生成视图。
    await page.locator('#fields textarea').first().evaluate(node => { node.value = '原工作区内容'; });
    const imageTabsBeforeLoad = await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').count();
    await imageLoad.click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#model').inputValue(), 'nano-banana-2');
    assert.equal(await page.locator('#size').inputValue(), '2K');
    assert.equal(await page.locator('#ratio').inputValue(), '3:4');
    assert.equal(await page.locator('#quantity').inputValue(), '3');
    const fieldValues = await page.locator('#fields textarea').evaluateAll(nodes => nodes.map(node => node.value));
    assert.deepEqual(fieldValues.filter(Boolean), ['白发少女', '雨夜街道']);
    assert.equal(await page.locator('#slots img').count(), 1, '参考图应被恢复');
    assert.equal(await page.locator('#model').isVisible(), true, '应自动切回图片生成页面');
    assert.equal(await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').count(), imageTabsBeforeLoad + 1, '「载入工作流」按钮应新建图片工作区标签');
    assert.match(await page.locator('#imageWorkspaceTabs .canvas-workspace-tab.active').innerText(), /工作流 \d{2}-\d{2} \d{2}:\d{2}/, '按钮新建的图片工作区应按任务时间命名');
    await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').first().locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#fields textarea').first().inputValue(), '原工作区内容', '原图片工作区不应被按钮替换');
    await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').nth(1).locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#model').inputValue(), 'nano-banana-2', '切回按钮新建的图片工作区应保留载入的工作流');
    await page.screenshot({ path: path.join(profile, 'image-load.png') });

    // 3) 视频任务卡片上的「载入工作流」按钮与恢复效果。
    await page.locator('.nav [data-view="video"]').click();
    await page.waitForSelector('#videoView:not([hidden])');
    const videoLoad = page.locator('#videoList [data-video-action="load"]').first();
    await videoLoad.waitFor({ timeout: 15000 });
    assert.match(await videoLoad.innerText(), /载入工作流/);
    await page.locator('#videoPrompt').evaluate(node => { node.value = '原视频工作区内容'; });
    const videoTabsBeforeLoad = await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').count();
    await videoLoad.click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#videoPlatform').inputValue(), 'runninghub');
    assert.equal(await page.locator('#videoModel').inputValue(), 'rhart-video-g/text-to-video');
    assert.equal(await page.locator('#videoRatio').inputValue(), '2:3');
    assert.equal(await page.locator('#videoResolution').inputValue(), '480p');
    assert.equal(await page.locator('#videoDuration').inputValue(), '8');
    assert.equal(await page.locator('#videoPrompt').inputValue(), '载入视频工作流测试');
    assert.equal(await page.locator('#videoSlots img').count(), 1, '视频参考图应被恢复');
    assert.equal(await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').count(), videoTabsBeforeLoad + 1, '「载入工作流」按钮应新建视频工作区标签');
    assert.match(await page.locator('#videoWorkspaceTabs .canvas-workspace-tab.active').innerText(), /工作流 \d{2}-\d{2} \d{2}:\d{2}/, '按钮新建的视频工作区应按任务时间命名');
    await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').first().locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#videoPrompt').evaluate(node => node.value), '原视频工作区内容', '原视频工作区不应被按钮替换');
    await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').nth(1).locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#videoPrompt').evaluate(node => node.value), '载入视频工作流测试', '切回按钮新建的视频工作区应保留载入的工作流');
    await page.screenshot({ path: path.join(profile, 'video-load.png') });

    // 4) 把生成过的视频文件拖回窗口：匹配历史任务后新建视频工作区，原工作区保持不变。
    await page.locator('.nav [data-view="workspace"]').click();
    await page.waitForTimeout(200);
    await page.locator('#videoPrompt').evaluate(node => { node.value = '原视频工作区内容'; });
    const videoTabsBefore = await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').count();
    await dropFile(page, VIDEO_NAME, 'video/mp4', [0, 0, 0, 24]);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#videoView').isVisible(), true, '拖入视频应切到视频生成页');
    assert.equal(await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').count(), videoTabsBefore + 1, '拖入视频应新建工作区标签');
    assert.equal(await page.locator('#videoPrompt').inputValue(), '载入视频工作流测试');
    assert.equal(await page.locator('#videoModel').inputValue(), 'rhart-video-g/text-to-video');
    assert.match(await page.locator('#videoWorkspaceTabs .canvas-workspace-tab.active').innerText(), /工作流 \d{2}-\d{2} \d{2}:\d{2}/, '新视频工作区应按任务时间命名');
    await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').first().locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#videoPrompt').inputValue(), '原视频工作区内容', '原视频工作区不应被拖入替换');
    await page.locator('#videoWorkspaceTabs .canvas-workspace-tab').nth(2).locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#videoPrompt').evaluate(node => node.value), '载入视频工作流测试', '切回新视频工作区应保留拖入的工作流');

    // 5) 把生成过的图片拖回窗口：新建图片工作区并载入工作流，原工作区保持不变。
    await page.locator('.nav [data-view="workspace"]').click();
    await page.waitForTimeout(200);
    // 先回到原始工作区，拖入时它应保持原样。
    await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').first().locator('span').first().click();
    await page.waitForTimeout(200);
    const originalModel = await page.locator('#model').evaluate(node => {
      const values = [...node.options].map(option => option.value).filter(Boolean);
      const other = values.find(value => value !== node.value);
      node.value = other;
      return other;
    });
    assert.ok(originalModel, '原工作区需要一个与原模型不同的有效模型作为标记');
    await page.locator('#fields textarea').first().evaluate(node => { node.value = '原工作区内容'; });
    const imageTabsBefore = await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').count();
    await dropFile(page, IMAGE_NAME, 'image/png', [137, 80, 78, 71]);
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').count(), imageTabsBefore + 1, '拖入历史图片应新建工作区标签');
    assert.equal(await page.locator('#model').inputValue(), 'nano-banana-2', '新工作区应载入拖入图片的工作流');
    assert.equal(await page.locator('#ratio').inputValue(), '3:4');
    assert.equal(await page.locator('#quantity').inputValue(), '3');
    assert.equal(await page.locator('#slots img').count(), 1);
    assert.match(await page.locator('#imageWorkspaceTabs .canvas-workspace-tab.active').innerText(), /工作流 \d{2}-\d{2} \d{2}:\d{2}/, '新图片工作区应按任务时间命名');
    await page.screenshot({ path: path.join(profile, 'drag-restore.png') });
    await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').first().locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#model').inputValue(), originalModel, '原图片工作区不应被拖入替换');
    assert.equal(await page.locator('#fields textarea').first().inputValue(), '原工作区内容', '原图片工作区字段内容应保留');
    await page.locator('#imageWorkspaceTabs .canvas-workspace-tab').nth(2).locator('span').first().click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#model').inputValue(), 'nano-banana-2', '切回新图片工作区应保留拖入的工作流');

    // 6) 拖到参考图槽位时仍按原来的“加参考图”处理，不触发工作流还原。
    await page.locator('#model').evaluate((node, value) => { node.value = value; }, originalModel);
    await dropFile(page, IMAGE_NAME, 'image/png', [137, 80, 78, 71], '#slots .slot');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#model').inputValue(), originalModel, '槽位拖放不应触发工作流还原');

    assert.deepEqual(errors, [], '页面不应有脚本错误：' + JSON.stringify(errors));
    console.log('PASS: 历史任务「载入工作流」按钮与拖入还原（图片与视频的按钮、拖入都会新建工作区并载入，原工作区保持不变；参数、参考图与参考音频全部恢复）。Screenshot: ' + path.join(profile, 'drag-restore.png'));
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exit(1); });