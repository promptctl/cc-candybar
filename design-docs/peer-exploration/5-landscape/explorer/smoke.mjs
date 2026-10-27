// Opens the built page in the installed Chrome, walks intro → characteristic → project, and
// screenshots each step into /tmp. Fails on any page error.
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const page_ = fileURLToPath(new URL('../landscape.html', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('file://' + page_);
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/ccland/shot-1-intro.png' });
await page.getByRole('button', { name: 'Feeds data back into Claude' }).first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/ccland/shot-2-trait.png' });
await page.locator('aside .row button.ref').first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: '/tmp/ccland/shot-3-project.png' });
await page.fill('input', 'pet');
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/ccland/shot-4-search.png' });
await page.fill('input', '');
await page.mouse.move(500, 480);
await page.mouse.move(520, 470, { steps: 5 });
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/ccland/shot-5-lens.png' });
await page.getByTitle('hide the panel').click();
await page.waitForTimeout(800);
await page.screenshot({ path: '/tmp/ccland/shot-6-collapsed.png' });
await page.locator('input[type=range]').fill('10');
await page.mouse.move(520, 470, { steps: 5 });
await page.waitForTimeout(600);
await page.screenshot({ path: '/tmp/ccland/shot-7-scale10.png' });
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('ok');
