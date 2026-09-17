const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-history-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const statePath = path.join(profile, 'XieMengxiongWorkbench', 'workbench-state.json');
const readTasks = () => JSON.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')).storage.aiWorkbenchTasksV3);
let app;
let blocker;
const errors = [];
async function launch() {
  app = await electron.launch({executablePath: process.env.WORKBENCH_TEST_EXE || require('electron'), args: [...(process.env.WORKBENCH_TEST_EXE ? [] : [root]), '--user-data-dir=' + path.join(profile, 'electron')], env});
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#customTemplateSelect');
  return page;
}
async function close() {
  const exited = app.waitForEvent('close', {timeout: 15000});
  await app.evaluate(({BrowserWindow}) => { BrowserWindow.getAllWindows()[0].close(); });
  await exited;
  app = null;
}
(async () => {
  let page = await launch();
  // Establish an acknowledged older snapshot, then close with newer changes
  // still waiting in the application's actual task-save scheduler.
  await page.evaluate(async () => {
    tasks = [{key:'baseline', model:'test', prompt:'old', status:'failed', createdAt:1, refs:[]}];
    save();
    const storage = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
    await fetch('/api/workbench-state', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({state:{storage,updatedAt:Date.now()}})});
    tasks = Array.from({length:260}, (_, i) => ({key:'task-'+i, model:'test', prompt:'任务'+i+'x'.repeat(600), status:'failed', createdAt:i+2, refs:['/cache-media/references/test.png'], outputs:[{key:'output-'+i,status:'succeeded',image:'/generated-media/test.png'}]}));
    scheduleTasksSave();
  });
  await close();
  assert.equal(readTasks().length, 260, 'closing must flush all pending tasks, including records beyond 200');
  page = await launch();
  assert.equal(await page.evaluate(() => tasks.length), 260, 'restart must retain every task');
  assert.equal(await page.evaluate(() => findTask('task-259').refs[0]), '/cache-media/references/test.png');
  assert.equal(await page.evaluate(() => list.querySelectorAll('.task').length), 40, 'paginate rendering without pruning data');
  await page.locator('[data-task-page="workspace"][data-page="1"]').click();
  assert.equal(await page.evaluate(() => list.querySelector('.task').dataset.key), 'task-219');

  // A newer output that arrives during an in-flight save must survive closing.
  await page.route('**/api/workbench-state', async route => {
    if (route.request().method()==='PUT') await new Promise(resolve=>setTimeout(resolve,150));
    await route.continue();
  });
  await page.evaluate(() => {
    updateTask('task-259', {prompt:'updated while closing',status:'succeeded'});
    window.pendingSave = window.workbenchState.flush();
    setTimeout(()=>updateOutput('task-259','output-259',{sourceImage:'/generated-media/final.png'}),50);
  });
  await close();
  assert.equal(readTasks().find(t=>t.key==='task-259').prompt,'updated while closing');
  assert.equal(readTasks().find(t=>t.key==='task-259').outputs[0].sourceImage,'/generated-media/final.png');

  page = await launch();
  await page.evaluate(async () => {
    deleteTask('task-12');
    // Deliberately exceed Chromium localStorage quota, but stay below disk limit.
    findTask('task-259').refs=['data:image/png;base64,'+'A'.repeat(6*1024*1024)];
    scheduleTasksSave();
    document.querySelector('#fields textarea').value='关闭前最后输入的提示词';
    document.querySelector('#fields textarea').dispatchEvent(new Event('input',{bubbles:true}));
    customTemplates.push({key:'history-template',name:'退出前的模板',type:'person',values:{'内容':'保存模板测试'}});
    saveCustomTemplates();
  });
  const originalPort = Number(new URL(page.url()).port);
  await close();
  assert.equal(readTasks().length,259);
  assert.equal(readTasks().find(t=>t.key==='task-259').refs[0].length,6*1024*1024+22);
  // Occupy the old port to force a completely different localStorage origin.
  blocker=net.createServer(socket=>socket.destroy());
  await new Promise((resolve,reject)=>{blocker.once('error',reject);blocker.listen(originalPort,'127.0.0.1',resolve);});
  page=await launch();
  assert.notEqual(Number(new URL(page.url()).port),originalPort);
  assert.equal(await page.evaluate(()=>tasks.length),259);
  assert.equal(await page.evaluate(()=>!!findTask('task-12')),false,'deleted tasks must not resurrect');
  assert.equal(await page.evaluate(()=>findTask('task-259').refs[0].length),6*1024*1024+22);
  assert.equal(await page.locator('#fields textarea').first().inputValue(),'关闭前最后输入的提示词');
  assert.equal(await page.evaluate(()=>customTemplates.some(t=>t.key==='history-template')),true);
  await page.evaluate(()=>{findTask('task-259').refs=['/cache-media/references/test.png'];save();});

  // Disk write failures must keep the window open, then allow a successful retry.
  await app.evaluate(({dialog})=>{global.historySaveErrors=0;dialog.showMessageBox=async()=>{global.historySaveErrors++;return {response:0}};});
  await page.route('**/api/workbench-state', route=>route.request().method()==='PUT'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({ok:false,error:'simulated disk full'})}):route.continue());
  await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].close();});
  await page.waitForTimeout(700);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length),1);
  assert.ok(await app.evaluate(()=>global.historySaveErrors)>0);
  await page.unroute('**/api/workbench-state');
  await page.evaluate(()=>window.workbenchState.flush());
  const writeChecks=await page.evaluate(async()=>{
    const state=(await (await fetch('/api/workbench-state')).json()).state;
    const put=value=>fetch('/api/workbench-state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:value})}).then(r=>r.json());
    const concurrent=await Promise.all([put(state),put(state),put(state)]);
    const stale=await put({...state,updatedAt:1,storage:{aiWorkbenchTasksV3:'[]'}});
    return {concurrent:concurrent.every(r=>r.ok),staleRejected:!stale.ok};
  });
  assert.deepEqual(writeChecks,{concurrent:true,staleRejected:true});
  await close();
  await new Promise(resolve=>blocker.close(resolve));blocker=null;

  // Returning to the original origin must not revive its stale local copy.
  page=await launch();
  assert.equal(await page.evaluate(()=>tasks.length),259);
  assert.equal(await page.evaluate(()=>!!findTask('task-12')),false);
  assert.equal(await page.evaluate(()=>findTask('task-259').refs[0]),'/cache-media/references/test.png');
  // Frequent progress updates cannot keep postponing the task-save timer.
  await page.evaluate(()=>{
    window.progressTimer=setInterval(()=>updateTask('task-259',{progress:Math.random()*100}),30);
  });
  await page.waitForTimeout(900);
  assert.equal(typeof readTasks().find(t=>t.key==='task-259').progress,'number');
  await page.evaluate(async()=>{clearInterval(window.progressTimer);await window.workbenchState.flush();});
  const idleModified=fs.statSync(statePath).mtimeMs;
  await page.waitForTimeout(900);
  assert.equal(fs.statSync(statePath).mtimeMs,idleModified,'idle app must not endlessly rewrite its snapshot');
  await close();

  // An interrupted/corrupt primary snapshot has a validated previous backup.
  fs.writeFileSync(statePath,'{"broken":');
  page=await launch();
  assert.equal(await page.evaluate(()=>tasks.length),259);
  await page.evaluate(()=>{tasks=[];save();});
  await close();
  page=await launch();
  assert.equal(await page.evaluate(()=>tasks.length),0,'an intentionally emptied history stays empty');
  await close();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true, profile, tests:['immediate close with pending saves', '260 tasks and pagination', 'updates during save', '6 MB references beyond localStorage quota', 'port/origin change and stale local cache', 'prompts and templates', 'failed close and retry', 'concurrent writes and stale rejection', 'corrupt primary recovery', 'deletions remain deleted']}));
})().catch(async error => {console.error(error);if(app) await app.close().catch(()=>{});if(blocker)blocker.close();process.exitCode=1;});
