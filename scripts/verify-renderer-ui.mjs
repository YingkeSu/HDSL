/** Actual React shell/controller with a test-only transport; never real DSH evidence. */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const require = createRequire(resolve('apps/desktop/package.json'));
const { build } = require('esbuild');
const { chromium } = require(process.env.HDSL_PLAYWRIGHT_MODULE || 'playwright');
const output = resolve('.scratch/ui-a');
const evidence = resolve('design-demos/implemented');
mkdirSync(output, { recursive: true });
mkdirSync(evidence, { recursive: true });
await build({
  entryPoints: ['tests/renderer/support/browser-entry.ts'],
  outfile: `${output}/app.js`,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
copyFileSync('apps/desktop/src/renderer/styles.css', `${output}/styles.css`);
copyFileSync('apps/desktop/src/renderer/index.html', `${output}/index.html`);
const server = createServer((req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  const file = name === '/' ? 'index.html' : name.slice(1);
  if (!['index.html', 'styles.css', 'app.js'].includes(file)) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    'Content-Type',
    file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
  );
  res.end(readFileSync(`${output}/${file}`));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(6000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const checks = [];
const button = (name) => page.getByRole('button', { name, exact: true });
const nav = (name) => page.getByRole('navigation').getByRole('button', { name, exact: true });
const ready = async (scenario = '') => {
  await page.goto(`${url}/?scenario=${scenario}`);
  await button('新建环境').waitFor();
  await page.waitForFunction(() => !document.querySelector('#new-environment')?.disabled);
};
const enabled = async (name, value) => assert.equal(await button(name).isEnabled(), value, name);
const calls = (method) =>
  page.evaluate((name) => window.hdslTestCalls.filter((call) => call.method === name), method);
try {
  await ready();
  for (const [width, height] of [
    [1440, 900],
    [1100, 780],
    [1024, 768],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `overflow ${width}`,
    );
    const box = await button('启动环境').boundingBox();
    assert(box.y + box.height <= height + 1, `launch visible ${width}`);
    await page.screenshot({ path: `${evidence}/home-${width}.png`, fullPage: true });
  }
  checks.push('1440/1100/1024/390 layout, no horizontal overflow, launch visible');
  await page.setViewportSize({ width: 1100, height: 780 });
  await button('新建环境').click();
  assert.equal(
    await page.locator('#create-name').evaluate((el) => document.activeElement === el),
    true,
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.equal(await button('新建环境').evaluate((el) => document.activeElement === el), true);
  await button('新建环境').click();
  await page.getByLabel('环境名称', { exact: true }).fill('bad/name');
  await button('创建环境').click();
  await page.locator('dialog [role=alert]').waitFor();
  await page.getByLabel('环境名称', { exact: true }).fill('');
  assert.equal(await page.locator('dialog').isVisible(), true);
  await page.getByLabel('环境名称', { exact: true }).fill('新工作环境');
  await page.keyboard.press('Tab');
  assert.equal(
    await page.locator('#create-combination').evaluate((el) => document.activeElement === el),
    true,
  );
  await page.keyboard.press('Tab');
  assert.equal(await button('创建环境').evaluate((el) => document.activeElement === el), true);
  await page.keyboard.press('Enter');
  await page.locator('dialog').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: '任务', exact: true }).waitFor();
  await page.getByLabel('当前环境', { exact: true }).selectOption({ label: '新工作环境 · 已停止' });
  assert.equal((await calls('environments.create')).length, 2);
  checks.push(
    'dialog autofocus, Escape focus restoration, invalid name correction, keyboard creation',
  );
  await nav('启动').click();
  await button('启动环境').click();
  await enabled('启动环境', false);
  await button('打开工作界面').waitFor();
  await button('打开工作界面').click();
  await page.getByText('工作界面已打开：', { exact: false }).waitFor();
  await button('停止').click();
  await button('启动环境').waitFor();
  assert.equal((await calls('environments.start')).length, 1);
  assert.equal((await calls('environments.stop')).length, 1);
  await page.getByText('环境详情', { exact: true }).click();
  await button('导出诊断').click();
  await page.locator('.export-result').waitFor();
  checks.push('real controller start/open/stop/diagnostics wiring, repeated-start disabled');
  await nav('帮助').click();
  await page.getByText('配置环境凭据', { exact: true }).waitFor();
  assert((await page.locator('main').innerText()).includes('环境 → 导入环境凭据引用'));
  await nav('环境').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: '环境列表', exact: true }).waitFor();
  checks.push('navigation keyboard operation and native credential instructions');
  await ready('tracking');
  await button('启动环境').click();
  await button('重试获取状态').waitFor();
  await enabled('打开工作界面', false);
  await enabled('新建环境', false);
  assert.equal(await page.getByRole('progressbar').count(), 0);
  await page.screenshot({ path: `${evidence}/tracking-error.png`, fullPage: true });
  await button('重试获取状态').click();
  await page.waitForFunction(() => !document.querySelector('.launch-button').disabled);
  assert.equal((await calls('environments.start')).length, 1);
  assert.equal((await calls('operations.get')).length, 2);
  checks.push('missing first snapshot recovery only re-observes; mutation guards preserved');
  await ready('busy');
  await button('启动环境').click();
  await button('取消操作').waitFor();
  await enabled('新建环境', false);
  await button('取消操作').click();
  await page.getByText('状态：已取消', { exact: true }).waitFor();
  checks.push('busy task cancellation');
  await ready('failure');
  await button('启动环境').click();
  await page.getByRole('alert').filter({ hasText: 'START_TIMEOUT' }).waitFor();
  checks.push('sanitized operation failure visible');
  await ready('empty');
  await button('创建第一个环境').click();
  await page.getByLabel('环境名称', { exact: true }).fill('第一个环境');
  await button('创建环境').click();
  await page.locator('dialog').waitFor({ state: 'detached' });
  await button('启动环境').waitFor();
  checks.push('empty-state creation');
  await page.goto(`${url}/?scenario=load-failure`);
  await button('重新加载').click();
  await page.waitForFunction(() => !document.querySelector('#new-environment').disabled);
  checks.push('initial load failure recovery');
  await ready('long');
  for (const width of [1100, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  checks.push('80-character environment names');
  assert.deepEqual(errors, []);
  rmSync(`${evidence}/failure.png`, { force: true });
  writeFileSync(
    `${evidence}/verification.json`,
    JSON.stringify(
      {
        scope:
          'Production React renderer/controller, mocked contract transport; no real DSH acceptance',
        checks,
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ result: 'PASS', checks, pageErrors: errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${evidence}/failure.png`, fullPage: true });
  throw error;
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
