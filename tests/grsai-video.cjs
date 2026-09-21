const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-video-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const GRSAI_MP4 = 'https://file1.aitohumanize.com/file/video-grsai-001.mp4';
const RH_MP4 = 'https://www.runninghub.cn/file/video-rh-001.mp4';

const waitFor = async (page, list, minimum = 1, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (list.length < minimum) {
    if (Date.now() > deadline) throw new Error('未等到请求，已记录：' + JSON.stringify(list));
    await page.waitForTimeout(250);
  }
};

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

    const grsaiCreates = [];
    const grsaiResults = [];
    const rhCreates = [];
    const rhQueries = [];
    const rhUploads = [];
    // Every upstream call is mocked; the real Grsai / RunningHub APIs are never contacted.
    await page.route('**/*.mp4', route => route.fulfill({ status: 200, contentType: 'video/mp4', body: '' }));
    await page.route('**/v1/api/generate', async route => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      grsaiCreates.push(body);
      await route.fulfill({ json: { id: 'grs-video-' + grsaiCreates.length, status: 'running', progress: 5 } });
    });
    await page.route('**/v1/api/result*', async route => {
      grsaiResults.push(route.request().url());
      await route.fulfill({ json: { id: 'grs-video-1', status: 'succeeded', progress: 100, results: [{ url: GRSAI_MP4 }] } });
    });
    await page.route('**/api/runninghub-upload', async route => {
      rhUploads.push({ headers: route.request().headers(), body: JSON.parse(route.request().postData() || '{}') });
      await route.fulfill({ json: { code: 0, data: { fileUrl: '/cache-media/references/video-ref-1.jpg' } } });
    });
    await page.route('**/rh-api/**', async route => {
      const request = route.request();
      const isQuery = request.url().includes('/rh-api/query');
      const record = { url: new URL(request.url()).pathname, headers: request.headers(), body: JSON.parse(request.postData() || '{}') };
      if (isQuery) {
        rhQueries.push(record);
        return route.fulfill({ json: { code: 0, data: { taskStatus: 'SUCCEEDED', results: [{ url: RH_MP4 }] } } });
      }
      rhCreates.push(record);
      await route.fulfill({ json: { code: 0, data: { taskId: 'rh-video-' + rhCreates.length, taskStatus: 'RUNNING' } } });
    });

    await page.evaluate(() => { apiKey.value = 'test-only'; runninghubKey.value = 'test-only-key'; });

    // 1) 导航：视频生成入口与独立视图。
    const videoNav = page.locator('.nav [data-view="video"]');
    assert.match(await videoNav.innerText(), /视频生成/);
    await videoNav.click();
    await page.waitForSelector('#videoView:not([hidden])');
    assert.equal(await page.locator('#videoView #videoPrompt').isVisible(), true);

    // 2) Grsai 只列视频模型，不含任何图片模型。
    const grsaiModels = await page.locator('#videoModel option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.deepEqual(grsaiModels, ['minimax-h3'], 'Grsai 视频模块只应列出 minimax-h3');
    for (const value of grsaiModels) assert.equal(/image/i.test(value), false, '视频模块不得混入图片模型：' + value);
    assert.deepEqual(await page.locator('#videoRatio option').evaluateAll(nodes => nodes.map(node => node.value)), ['portrait', 'landscape']);
    assert.deepEqual(await page.locator('#videoResolution option').evaluateAll(nodes => nodes.map(node => node.value)), ['480p', '768p', '1080p']);
    assert.equal(await page.locator('#videoDuration option').count(), 15);

    // 3) 参考图 + minimax-h3 提交：base64 参考图、剩余参数按文档。
    const reference = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#2277cc' } }).png().toBuffer();
    await page.locator('#videoFile').setInputFiles({ name: 'video-ref.png', mimeType: 'image/png', buffer: reference });
    await page.waitForSelector('#videoSlots .slot img');
    await page.locator('#videoPrompt').fill('雨夜城市，镜头缓慢推进');
    await page.evaluate(() => {
      const ratio = document.querySelector('#videoRatio');
      ratio.value = 'landscape'; ratio.dispatchEvent(new Event('change', { bubbles: true }));
      const duration = document.querySelector('#videoDuration');
      duration.value = '6'; duration.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#videoSubmit').click();
    await waitFor(page, grsaiCreates);
    const grsaiBody = grsaiCreates[0];
    assert.equal(grsaiBody.model, 'minimax-h3');
    assert.equal(grsaiBody.prompt, '雨夜城市，镜头缓慢推进');
    assert.equal(grsaiBody.replyType, 'async');
    assert.equal(grsaiBody.aspectRatio, 'landscape');
    assert.equal(grsaiBody.resolution, '768p');
    assert.equal(grsaiBody.duration, 6);
    assert.equal(typeof grsaiBody.duration, 'number');
    assert.equal(grsaiBody.images.length, 1);
    assert.match(grsaiBody.images[0], /^data:image\/(jpeg|png);base64,/);
    assert.equal(grsaiBody.images[0].startsWith('/cache-media/'), false);

    // 4) 轮询结果 -> <video>，而不是 <img>。
    await waitFor(page, grsaiResults);
    assert.match(grsaiResults[0], /^http:\/\/(?:localhost|127\.0\.0\.1):\d+\/v1\/api\/result\?id=grs-video-1$/, '结果查询必须走本地代理');
    await page.waitForSelector('#videoList video');
    assert.equal(await page.locator('#videoList video').first().getAttribute('src'), GRSAI_MP4);
    assert.equal(await page.locator('#videoList img').count(), 0);
    assert.equal((await page.locator('#videoList .status').first().innerText()).trim(), '已完成');

    // 5) 1080p 时长钳制：15 秒必须落到 10 秒。
    await page.evaluate(() => {
      const resolution = document.querySelector('#videoResolution');
      resolution.value = '1080p'; resolution.dispatchEvent(new Event('change', { bubbles: true }));
      const duration = document.querySelector('#videoDuration');
      duration.value = '15'; duration.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.locator('#videoDuration').inputValue(), '10');
    await page.locator('#videoPrompt').fill('1080p 时长钳制测试');
    await page.locator('#videoSubmit').click();
    await waitFor(page, grsaiCreates, 2);
    assert.equal(grsaiCreates[1].resolution, '1080p');
    assert.equal(grsaiCreates[1].duration, 10);
    await waitFor(page, grsaiResults, 2);

    // 6) RunningHub：只列视频模型（7 个），参考图先上传再走图生视频端点。
    await page.evaluate(() => {
      const platform = document.querySelector('#videoPlatform');
      platform.value = 'runninghub'; platform.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const rhModels = await page.locator('#videoModel option').evaluateAll(nodes => nodes.map(node => node.value));
    assert.equal(rhModels.length, 7, 'RunningHub 视频模型应为 7 个');
    for (const value of rhModels) assert.match(value, /\/text-to-video/, 'RunningHub 视频模块只应列视频模型：' + value);
    assert.equal(rhModels.includes('minimax-h3'), false);
    await page.locator('#videoPrompt').fill('RunningHub 视频图生视频测试');
    await page.locator('#videoSubmit').click();
    await waitFor(page, rhUploads);
    assert.match(rhUploads[0].body.dataUrl, /^data:image\/(jpeg|png);base64,/);
    assert.equal(rhUploads[0].headers['x-runninghub-region'], 'cn');
    await waitFor(page, rhCreates);
    assert.equal(rhCreates[0].url, '/rh-api/rhart-video/sparkvideo-2.0/image-to-video');
    assert.equal(rhCreates[0].headers['x-runninghub-region'], 'cn');
    assert.equal(typeof rhCreates[0].body.firstFrameUrl, 'string');
    assert.ok(rhCreates[0].body.firstFrameUrl.length > 0);
    assert.equal(rhCreates[0].body.ratio, 'adaptive');
    assert.equal(rhCreates[0].body.resolution, '480p');
    assert.equal(rhCreates[0].body.duration, '5');
    await waitFor(page, rhQueries);
    assert.equal(rhQueries[0].url, '/rh-api/query');
    assert.equal(rhQueries[0].body.taskId, 'rh-video-1');
    await page.waitForSelector('#videoList video >> nth=1');

    // 7) 海外平台沿用同一套视频模型，但区域标记必须切到 global。
    await page.evaluate(() => {
      const platform = document.querySelector('#videoPlatform');
      platform.value = 'runninghub-global'; platform.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.deepEqual(await page.locator('#videoModel option').evaluateAll(nodes => nodes.map(node => node.value)), rhModels);
    await page.locator('#videoPrompt').fill('RunningHub 海外视频测试');
    await page.locator('#videoSubmit').click();
    await waitFor(page, rhCreates, 2);
    assert.equal(rhCreates[1].headers['x-runninghub-region'], 'global');
    assert.equal(rhCreates[1].url, '/rh-api/rhart-video/sparkvideo-2.0/image-to-video');
    await waitFor(page, rhQueries, 2);
    assert.equal(rhQueries[1].headers['x-runninghub-region'], 'global');

    // 8) 没有提示词时必须拦住，不能凭空发请求。
    const createsBefore = grsaiCreates.length + rhCreates.length;
    await page.evaluate(() => { document.querySelector('#videoPlatform').value = 'grsai'; document.querySelector('#videoPlatform').dispatchEvent(new Event('change', { bubbles: true })); });
    await page.locator('#videoPrompt').fill('');
    await page.locator('#videoSubmit').click();
    assert.equal(grsaiCreates.length + rhCreates.length, createsBefore);
    assert.match(await page.locator('#videoStatus').innerText(), /提示词/);

    // 9) 启动视图设置里出现视频生成。
    assert.equal(await page.locator('#settingsStartupView option[value="video"]').count(), 1);

    assert.deepEqual(errors, []);
    console.log('PASS: 视频生成模块（Grsai minimax-h3 单模型 + RunningHub 7 个视频模型，参考图 data URL / 上传首帧、1080p 时长钳制、轮询出 <video>）。All upstream calls mocked; no paid calls.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
