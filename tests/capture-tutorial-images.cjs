const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'tutorial-assets');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-tutorial-capture-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;

// Illustration tiles for the screenshot fixture, not customer reference images.
const samples = {
  scene: ['#e1e9df', '#426953', '<path d="M0 42 26 15l22 23 13-12 35 23v15H0Z"/><circle cx="73" cy="13" r="6" fill="#c9955d"/><circle cx="46" cy="30" r="4" fill="#f3d4b9"/><path d="M46 35v11m0-9-7 6m7-6 7 5m-7 3-6 10m6-10 5 10" fill="none" stroke="#f3d4b9" stroke-width="3"/>'],
  product: ['#f3e2d2', '#754932', '<rect x="28" y="27" width="40" height="27" rx="6"/><path d="M39 28v-6a9 9 0 0 1 18 0v6" fill="none" stroke="#754932" stroke-width="3"/><path d="M32 35h32" stroke="#d5a783" stroke-width="2"/>'],
  face: ['#eddfe4', '#4a3944', '<path d="M33 37v-9a15 15 0 0 1 30 0v18H33Z"/><ellipse cx="48" cy="34" rx="11" ry="14" fill="#e5ab8e"/><path d="M36 28c8 0 14-4 17-9l6 11 1-8-9-7-13 5Z"/><path d="M31 64v-5c2-5 10-9 17-9s15 4 17 9v5Z" fill="#88718a"/>'],
  garment: ['#dde8ee', '#586e88', '<path d="m38 15-15 9 6 13 7-4v21h24V33l7 4 6-13-15-9-10 9Z"/><path d="M48 24v30" stroke="#b9c7d5" stroke-width="2"/>']
};

async function placeSamples(page, selector, items) {
  await page.locator(selector).evaluate((slots, entries) => {
    for (const [index, [label, art]] of entries.entries()) {
      const slot = slots.children[index];
      const img = new Image();
      img.src = art;
      const number = slot.querySelector('b');
      number.textContent = `图${index+1} · ${label}`;
      slot.prepend(img);
    }
  }, items.map(([label, key]) => {
    const [bg, fg, drawing] = samples[key];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 64"><rect width="96" height="64" fill="${bg}"/><g fill="${fg}">${drawing}</g></svg>`;
    return [label, `data:image/svg+xml,${encodeURIComponent(svg)}`];
  }));
}

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const app = await electron.launch({ executablePath: require('electron'), args: [root, '--user-data-dir=' + path.join(profile, 'electron')], env });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.locator('#creationToolsNavTitle').waitFor();
    await page.addStyleTag({ content: `
      .layout-splitter { display: none !important; }
      #reverseView .reverse-layout { grid-template-columns: 1fr !important; max-width: 700px; }
      #reverseView .reverse-output { display: none; }
      #reverseView .reverse-controls { grid-column: 1 / -1 !important; min-height: 0 !important; }
      #reverseView #reverseInstruction { min-height: 232px !important; }
      #workspaceView .layout { grid-template-columns: 1fr !important; max-width: 700px; }
      #workspaceView .layout > .tasks { display: none; }
      #workspaceView .layout > .panel { grid-column: 1 / -1; grid-row: 1; }
      #reverseView .ref, #workspaceView .ref { min-height: 0 !important; }
      #reverseSlots, #slots { grid-template-columns: repeat(5, minmax(0, 1fr)) !important; }
      #reverseSlots .slot[data-i]:nth-child(n+6), #slots .slot[data-i]:nth-child(n+6) { display: none; }
      #reverseSlots .slot b, #slots .slot b { white-space: nowrap; max-width: 100%; }
    ` });
    const save = async (locator, name) => {
      await page.evaluate(() => document.activeElement?.blur());
      await locator.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    };
    const reverse = page.locator('#reverseView .reverse-controls');
    const reverseTemplate = reverse.locator('#reverseTemplateSelect');
    const reverseInstruction = reverse.locator('#reverseInstruction');
    await page.locator('.nav button[data-view="reverse"]').click();
    await placeSamples(page, '#reverseSlots', [['场景与姿势', 'scene'], ['产品', 'product'], ['五官', 'face'], ['服装', 'garment']]);
    await reverseTemplate.selectOption('builtin:1');
    const firstPrompt = await reverseInstruction.inputValue();
    const withGarment = firstPrompt.replace('人物五官参考图3。', '人物五官参考图3，服装参考图4。');
    if (firstPrompt === withGarment) throw new Error('Update the tutorial clothing example to match default template 1.');
    await reverseInstruction.fill(withGarment);
    await reverseInstruction.evaluate(input => {
      input.setSelectionRange(0, 0);
      input.blur();
      input.scrollTop = 0;
    });
    await save(reverse, 'reverse-first');

    await page.locator('.nav button[data-view="workspace"]').click();
    const workspace = page.locator('#workspaceView');
    const template = workspace.locator('#customTemplateSelect');
    await template.selectOption('builtin:person');
    await template.click();
    const templateMenu = page.locator('.workbench-select-popup:popover-open');
    await templateMenu.getByRole('option', { name: '静物模板', exact: true }).waitFor();
    const toolbar = await workspace.locator('.template-manager').boundingBox();
    const menu = await templateMenu.boundingBox();
    const x = Math.floor(Math.min(toolbar.x, menu.x) - 8);
    const y = Math.floor(Math.min(toolbar.y, menu.y) - 8);
    await page.screenshot({
      path: path.join(output, 'template-select.png'),
      clip: { x, y, width: Math.ceil(Math.max(toolbar.x + toolbar.width, menu.x + menu.width) - x + 8), height: Math.ceil(Math.max(toolbar.y + toolbar.height, menu.y + menu.height) - y + 8) },
      animations: 'disabled'
    });
    await page.keyboard.press('Escape');
    await placeSamples(page, '#slots', [['五官', 'face'], ['产品', 'product'], ['服装', 'garment']]);
    await workspace.locator('#promptImport').fill('人物特征：参考图1的五官。\n服装细节：图3的蓝灰色衬衫外套。\n动作姿态：人物侧身站立，右手提起图2的棕色手袋。\n布局：人物靠左，右侧留出山景空间。');
    const hideFields = await page.addStyleTag({ content: '#workspaceView #fields { display: none; }' });
    await save(workspace.locator('.layout > .panel'), 'generate-first');
    await hideFields.evaluate(style => style.remove());

    const fields = workspace.locator('#fields');
    await fields.locator('#template-field-0-0').fill('保持原参考人物的五官和发型。');
    await fields.locator('#template-field-0-1').fill('保持原来的蓝灰色衬衫外套。');
    const importBox = workspace.locator('#promptImport');
    await importBox.fill([
      '动作姿态：侧身坐在石阶上，左手搭在膝上，右手握住手袋。',
      '佩戴方式：右手提住手袋的提手。',
      '视角：平视，中景。',
      '布局：人物居画面左侧，手袋与手部清晰可见。',
      '景深：浅景深，背景柔和虚化。'
    ].join('\n'));
    await workspace.locator('#promptParse').click();
    await importBox.evaluate(input=>{input.scrollTop=0});
    await page.addStyleTag({ content: `
      #workspaceView .layout > .panel > :not(.prompt-import, #fields) { display: none !important; }
      #workspaceView .prompt-import { border-top: 0; margin-top: 0; padding-top: 0; }
      #workspaceView #promptImport { min-height: 112px; }
      #workspaceView #fields .group:nth-child(n+3) { display: none; }
      #workspaceView #fields :is(#template-field-0-2,#template-field-0-3,#template-field-1-0,#template-field-1-1,#template-field-1-2) {
        border: 2px solid #79ca9d !important;
      }
    ` });
    await save(workspace.locator('.layout > .panel'), 'generate-pose');
  } finally {
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
