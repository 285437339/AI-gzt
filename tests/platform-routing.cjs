const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-routing-'));
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

    const calls = [];
    const push = (kind, request) => calls.push({ kind, region: request.headers()['x-runninghub-region'] || '', url: request.url() });
    const countOf = (kind, region) => calls.filter(call => call.kind === kind && call.region === region).length;
    const waitFor = async (kind, region, minimum = 1, timeout = 40000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = calls.filter(call => call.kind === kind && call.region === region).length;
        if (found >= minimum) return found;
        if (Date.now() > deadline) throw new Error(`未等到 ${kind}/${region}，已记录：${JSON.stringify(calls)}`);
        await page.waitForTimeout(250);
      }
    };

    await page.route('**/rh-api/**', async route => {
      const request = route.request();
      const query = request.url().includes('/rh-api/query');
      push(query ? 'query' : 'create', request);
      if (query) return route.fulfill({ json: { code: 0, data: { taskStatus: 'RUNNING', progress: 10 } } });
      return route.fulfill({ json: { code: 0, data: { taskId: 'rh-task-' + calls.length, taskStatus: 'RUNNING' } } });
    });
    await page.route('**/rh-llm/**', async route => {
      push('llm', route.request());
      await route.fulfill({ json: { code: 0, data: { choices: [{ message: { content: '分流测试回复' } }] } } });
    });
    await page.route('**/api/runninghub-upload', async route => {
      push('upload', route.request());
      await route.fulfill({ json: { code: 0, data: { fileUrl: '/cache-media/routing-ref.png' } } });
    });

    const popup = page.locator('.workbench-select-popup');
    const choosePlatform = async (label, selector = '#generationPlatform') => {
      await page.locator(selector).click();
      await popup.waitFor({ state: 'visible' });
      await popup.getByRole('option', { name: label, exact: true }).click();
    };

    // 1) 海外平台：生成提交、参考图上传、任务查询都必须带 global 标记。
    await choosePlatform('RunningHub 海外');
    assert.equal(await page.locator('#apiPlatform').inputValue(), 'runninghub-global');
    await page.evaluate(() => { runninghubKey.value = 'test-only-key'; });
    const reference = await require('sharp')({ create: { width: 64, height: 48, channels: 3, background: '#2277cc' } }).png().toBuffer();
    await page.locator('#file').setInputFiles({ name: 'routing-ref.png', mimeType: 'image/png', buffer: reference });
    await page.waitForFunction(() => refs[0]?.startsWith('/cache-media/'));
    await page.locator('#fields textarea').first().fill('海外分流测试');
    await page.locator('#submit').click();
    assert.equal(await waitFor('upload', 'global'), 1);
    await waitFor('create', 'global');
    await waitFor('query', 'global');

    // 2) 切回国内平台后，已提交的海外任务查询仍然走海外，不能被界面当前选择带偏。
    const globalQueriesBefore = countOf('query', 'global');
    await choosePlatform('RunningHub 国内');
    assert.equal(await page.locator('#apiPlatform').inputValue(), 'runninghub');
    await waitFor('query', 'global', globalQueriesBefore + 1);

    // 3) 设置面板：接口地址自动配置并隐藏，平台下拉下面只显示对应的 Key 输入。
    await page.locator('.nav [data-view="settings"]').click();
    await page.waitForSelector('#settingsPlatform');
    assert.deepEqual(await page.evaluate(() => [...document.querySelector('label[for="settingsPlatform"]').parentElement.children].filter(node => node.tagName === 'LABEL').map(node => node.querySelector('input,select')?.id)), ['settingsPlatform', 'settingsApiKey', 'settingsRunninghubKey']);
    assert.equal(await page.locator('#settingsApiUrl').getAttribute('type'), 'hidden');
    assert.equal(await page.locator('#settingsApiUrl').isVisible(), false);
    assert.equal(await page.locator('#apiUrl').getAttribute('type'), 'hidden');
    await choosePlatform('RunningHub 海外', '#settingsPlatform');
    assert.equal(await page.locator('#settingsRunninghubUrl').inputValue(), 'https://www.runninghub.ai/openapi/v2');
    assert.equal(await page.locator('#settingsRunninghubKey').isVisible(), true);
    assert.equal(await page.locator('#settingsApiKey').isVisible(), false);
    await choosePlatform('RunningHub 国内', '#settingsPlatform');
    assert.equal(await page.locator('#settingsRunninghubUrl').inputValue(), 'https://www.runninghub.cn/openapi/v2');
    assert.equal(await page.locator('#settingsRunninghubKey').isVisible(), true);
    await choosePlatform('Grsai', '#settingsPlatform');
    assert.equal(await page.locator('#settingsApiKey').isVisible(), true);
    assert.equal(await page.locator('#settingsRunninghubKey').isVisible(), false);
    assert.equal(await page.locator('#settingsApiUrl').inputValue(), 'https://grsai.dakka.com.cn/v1/api/generate');
    await choosePlatform('RunningHub 国内', '#settingsPlatform');
    assert.equal(await page.locator('#settingsApiKey').isVisible(), false);

    // 4) 反推：国内平台走 cn。
    await page.locator('.nav [data-view="reverse"]').click();
    await page.locator('#reverseFile').setInputFiles({ name: 'routing-ref.png', mimeType: 'image/png', buffer: reference });
    await page.waitForFunction(() => reverseRefs[0]?.startsWith('/cache-media/'));
    await page.locator('#reverseSubmit').click();
    await waitFor('upload', 'cn');
    await waitFor('llm', 'cn');

    // 5) 聊天：选择海外平台时走 global。
    await page.locator('.nav [data-view="chat"]').click();
    await page.evaluate(() => {
      const select = document.querySelector('#chatPlatform');
      select.value = 'runninghub-global';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.locator('#chatInput').fill('海外分流测试');
    await page.locator('#chatSend').click();
    await waitFor('llm', 'global');

    assert.deepEqual(errors, []);
    console.log('PASS: RunningHub 国内/海外分流（生成提交、参考图上传、任务查询、反推、聊天）');
    console.log(JSON.stringify(calls, null, 1));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
