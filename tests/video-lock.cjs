const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const videoPassword = process.env.WORKBENCH_VIDEO_PASSWORD;
assert.ok(videoPassword, 'Set WORKBENCH_VIDEO_PASSWORD to run video tests');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-video-lock-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({ executablePath: process.env.WORKBENCH_TEST_EXE || require('electron'), args: [...(process.env.WORKBENCH_TEST_EXE ? [] : [root]), '--user-data-dir=' + path.join(profile, 'electron')], env });
  try {
    // Mock upstream in the main process, so real local authorization is exercised.
    await app.evaluate(() => {
      const { EventEmitter } = process.getBuiltinModule('events');
      global.videoTestUpstreamCalls = [];
      process.getBuiltinModule('https').request = (options, callback) => {
        global.videoTestUpstreamCalls.push(options);
        const request = new EventEmitter();
        request.setTimeout = () => request;
        request.end = () => {
          const response = new EventEmitter();
          response.statusCode = 200;
          response.headers = {};
          response.setEncoding = () => {};
          callback(response);
          response.emit('data', Buffer.from('{"ok":true}'));
          response.emit('end');
        };
        return request;
      };
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForSelector('#customTemplateSelect');
    const origin = new URL(page.url()).origin;
    const routes = [
      ['/v1/api/generate', { model: 'minimax-h3' }],
      ['/rh-api/rhart-video/sparkvideo-2.0/text-to-video', {}],
      ['/rh-api/seedance-v1.5-pro/image-to-video-fast', {}],
      ['/rh-api/rhart-video-g-official/text-to-video-v1.5', {}]
    ];
    for (const [route, data] of routes) {
      for (const headers of [{}, { 'X-Workbench-Video-Token': 'forged-token' }]) {
        const response = await page.request.post(origin + route, { data, headers });
        assert.equal(response.status(), 403);
        assert.equal((await response.json()).code, 'VIDEO_LOCKED');
      }
    }
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), 0);
    const image = await page.request.post(origin + '/v1/api/generate', { data: { model: 'nano-banana-2' } });
    assert.equal(image.status(), 200, '图片功能无需视频密码');

    const nav = page.locator('.nav [data-view="video"]');
    await nav.click();
    assert.equal(await page.locator('#videoView').isVisible(), false);
    assert.equal(await page.locator('#videoUnlockPassword').getAttribute('type'), 'password');
    await page.locator('#videoUnlockPassword').fill('wrong-password');
    await page.locator('#videoUnlockConfirm').click();
    await page.waitForFunction(() => document.querySelector('#videoUnlockError').textContent.includes('不正确'));
    assert.equal(await page.locator('#videoView').isVisible(), false);
    await page.locator('#videoUnlockCancel').click();
    assert.equal(await page.locator('#workspaceView').isVisible(), true);
    await nav.click();
    await page.locator('#videoUnlockPassword').fill(videoPassword);
    await page.locator('#videoUnlockPassword').press('Enter');
    await page.waitForSelector('#videoView:not([hidden])');
    assert.equal(await page.locator('#videoUnlockPassword').inputValue(), '');
    for (const [route, data] of routes) {
      const status = await page.evaluate(async ({ route, data }) => (await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })).status, { route, data });
      assert.equal(status, 200, '已解锁视频请求通过真实本地服务');
    }
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.some(call => Object.keys(call.headers).some(key => key.toLowerCase() === 'x-workbench-video-token'))), false, '解锁凭证不得传给第三方');
    await page.locator('.nav [data-view="workspace"]').click();
    await nav.click();
    assert.equal(await page.locator('#videoUnlockDialog').isVisible(), false, '同次打开无需重复输入');

    await page.evaluate(() => {
      workbenchSettings.startupView = 'video';
      localStorage.setItem('aiWorkbenchSettingsV1', JSON.stringify(workbenchSettings));
      localStorage.setItem('aiWorkbenchVideoTasksV1', JSON.stringify([{ key: 'saved-video-lock-test', platform: 'grsai', model: 'minimax-h3', prompt: '拖入恢复测试', url: 'https://example.invalid/saved-video.mp4', refs: [], status: 'succeeded' }]));
    });
    await page.reload();
    await page.waitForSelector('#customTemplateSelect');
    assert.equal(await page.evaluate(() => window.workbenchVideoAccess.isUnlocked()), false);
    // A saved startup preference must not bypass the lock.
    await page.waitForSelector('#videoUnlockDialog[open]');
    assert.equal(await page.locator('#videoView').isVisible(), false);
    await page.locator('#videoUnlockPassword').press('Escape');

    const before = await app.evaluate(() => global.videoTestUpstreamCalls.length);
    // Canvas submits through fetchJson without opening the video page.
    await page.evaluate(() => { window.canvasLockResult = null; void fetchJson('/rh-api/seedance-v1.5-pro/text-to-video', { method: 'POST', body: '{}' }).then(() => { window.canvasLockResult = 'sent'; }, () => { window.canvasLockResult = 'cancelled'; }); });
    await page.waitForSelector('#videoUnlockDialog[open]');
    await page.locator('#videoUnlockCancel').click();
    await page.waitForFunction(() => window.canvasLockResult === 'cancelled');
    assert.equal(await app.evaluate(() => global.videoTestUpstreamCalls.length), before);
    const workspaceCount = await page.evaluate(() => window.__videoWorkspaceTabs.list().length);
    assert.equal(await page.evaluate(() => window.__workbenchVideoDropUrl('https://example.invalid/saved-video.mp4')), true);
    await page.waitForSelector('#videoUnlockDialog[open]');
    await page.locator('#videoUnlockCancel').click();
    assert.equal(await page.evaluate(() => window.__videoWorkspaceTabs.list().length), workspaceCount, '取消拖入解锁不能创建工作区');
    await page.evaluate(() => window.__workbenchVideoDropUrl('https://example.invalid/saved-video.mp4'));
    await page.locator('#videoUnlockPassword').fill(videoPassword);
    await page.locator('#videoUnlockConfirm').click();
    await page.waitForSelector('#videoView:not([hidden])');
    assert.equal(await page.locator('#videoPrompt').inputValue(), '拖入恢复测试');
    assert.deepEqual(errors, []);
    console.log('PASS: 视频密码锁（服务端拦截、错误密码、取消、解锁、刷新重锁、画布请求、图片不受影响；无付费请求）');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
