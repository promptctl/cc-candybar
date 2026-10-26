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
await browser.close();
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('ok');
