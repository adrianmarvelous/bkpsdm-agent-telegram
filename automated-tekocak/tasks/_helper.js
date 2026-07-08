/**
 * Helper: login dulu, lalu jalankan task.
 * Dipakai oleh task standalone (node tasks/generate.js dll)
 */
const { chromium } = require('playwright');
const config = require('../config');
const login = require('./login');

async function loginThenRun(taskFn, taskName) {
  const browser = await chromium.launch({ headless: config.HEADLESS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await login.run(page);
    await taskFn(page);
    console.log(`\n✅ Task ${taskName} selesai!`);
    await page.pause();
  } catch (e) {
    console.error('✗ Error:', e.message);
    await browser.close();
  }
}

module.exports = { loginThenRun };
