const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-banana-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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

    const bodies = [];
    // Every upstream call is mocked; the real Grsai API is never contacted.
    await page.route('**/v1/api/generate', async route => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      bodies.push(body);
      await route.fulfill({ json: { id: 'grs-task-' + bodies.length, status: 'running', progress: 10 } });
    });
    await page.route('**/v1/api/result*', async route => {
      await route.fulfill({ json: { id: 'grs-task-1', status: 'succeeded', progress: 100, results: [{ url: 'data:image/png;base64,' + PIXEL }] } });
    });

    await page.evaluate(() => {
      const select = document.querySelector('#apiPlatform');
      select.value = 'grsai';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      apiKey.value = 'test-only';
    });

    const reference = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#2277cc' } }).png().toBuffer();
    await page.locator('#file').setInputFiles({ name: 'banana-ref.png', mimeType: 'image/png', buffer: reference });
    await page.waitForFunction(() => refs[0]?.startsWith('/cache-media/'));
    // The UI keeps references as local cache paths; the upstream API cannot read them.
    assert.match(await page.evaluate(() => refs[0]), /^\/cache-media\/references\//);

    for (const model of ['nano-banana-2', 'gpt-image-2.5-sunburst']) {
      await page.evaluate(value => {
        const select = document.querySelector('#model');
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }, model);
      await page.locator('#fields textarea').first().fill('参考图转换测试 ' + model);
      await page.locator('#submit').click();
      const expected = model === 'nano-banana-2' ? 1 : 2;
      for (let waited = 0; bodies.length < expected && waited < 20000; waited += 250) await page.waitForTimeout(250);
      assert.equal(bodies.length, expected, `${model} 未提交生成请求`);
      const body = bodies.at(-1);
      assert.equal(body.model, model);
      assert.equal(body.replyType, 'async');
      assert.equal(body.images.length, 1);
      // Both models must upload the reference as a data URL instead of a local path.
      assert.match(body.images[0], /^data:image\/(jpeg|png);base64,/, `${model} 参考图必须以 data URL 提交`);
      assert.equal((body.images[0] || '').startsWith('/cache-media/'), false, `${model} 不能把本地缓存路径发给上游`);
    }

    assert.deepEqual(errors, []);
    console.log('PASS: Grsai nano-banana-2 与 gpt-image-2.5 均以 data URL 提交参考图，不再泄漏 /cache-media 本地路径。Model requests mocked; no paid calls.');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
