// Headless-Chrome check of the real export + board UI.
//   npm run build && npx vite preview --port 4179 &
//   npm i --no-save puppeteer-core && node scripts/e2e.mjs [url] [chromePath]
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const URL_ = process.argv[2] ?? 'http://localhost:4179/';
const CHROME = process.argv[3] ?? process.env.CHROME ?? '/usr/bin/google-chrome';
const SHOTS = process.env.SHOTS ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function openPage(viewport, { stubShare = false, clear = true } = {}) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (stubShare) {
    await page.evaluateOnNewDocument(() => {
      window.__shared = [];
      navigator.canShare = (d) => !!(d && d.files && d.files.length);
      navigator.share = async (d) => { for (const f of d.files) window.__shared.push({ name: f.name, type: f.type, head: (await f.text()).slice(0, 80) }); };
    });
  }
  await page.setViewport(viewport);
  await page.goto(URL_, { waitUntil: 'networkidle0' });
  if (clear) { await page.evaluate(() => localStorage.clear()); await page.reload({ waitUntil: 'networkidle0' }); }
  return page;
}
const clickText = async (page, sel, text) => {
  // trusted click (real input events), so Chrome treats downloads as user-initiated
  const h = await page.evaluateHandle((sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text)) ?? null, sel, text);
  const el = h.asElement();
  if (!el) throw new Error(`not found: ${sel} "${text}"`);
  await el.click();
  await sleep(350);
};
const chips = (page) => page.$$eval('.inst-chip', (els) => els.length);
async function waitDownload(dir, before) {
  for (let i = 0; i < 50; i++) {
    const f = readdirSync(dir).filter((n) => !n.endsWith('.crdownload') && !before.includes(n));
    if (f.length) return f[0];
    await sleep(100);
  }
  return null;
}

// ---------------------------------------------------------------- desktop
const dl = mkdtempSync(join(tmpdir(), 'penplot-dl-'));
const page = await openPage({ width: 1280, height: 1300 });
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl });

let before = readdirSync(dl);
// record the Blob type the app hands to createObjectURL
await page.evaluate(() => {
  const orig = URL.createObjectURL;
  URL.createObjectURL = (b) => { window.__blobType = b.type; return orig.call(URL, b); };
});
await clickText(page, 'button', '⬇ Download');
let file = await waitDownload(dl, before);
check(!!file && file.endsWith('.gcode'), `download filename ends in .gcode (${file})`);
check(!!file && !/\.(txt|text)$/i.test(file), 'download filename is not .txt/.text');
let body = file ? readFileSync(join(dl, file), 'utf8') : '';
check(body.startsWith('; ====') && body.split('\n')[1].startsWith('; Pen Plot'), 'content starts with the G-code header');
check(/^G28\b/m.test(body) && !/\bE\d/.test(body), 'content is real G-code (G28, no E)');
const blobType = await page.evaluate(() => window.__blobType);
check(blobType === 'application/octet-stream', `blob type is application/octet-stream (${blobType})`);

// board: duplicate (Ctrl+D), copy/paste (Ctrl+C / Ctrl+V), delete
await page.click('canvas.bed');
await page.evaluate(() => document.activeElement && document.activeElement.blur());
const n0 = await chips(page);
// select the copy by clicking its centre on the canvas
const box = await page.$eval('canvas.bed', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const pad = 26, s = (box.w - 2 * pad) / 220;
const toPx = (x, y) => ({ x: box.x + pad + x * s, y: box.y + pad + (220 - y) * s });
const cur = await page.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
const c0 = cur.instances[0];
let p = toPx(c0.x, c0.y);
await page.mouse.click(p.x, p.y);
await sleep(200);
await page.keyboard.down('Control'); await page.keyboard.press('KeyD'); await page.keyboard.up('Control');
await sleep(300);
check((await chips(page)) === n0 + 1, `Ctrl+D duplicates (${n0} -> ${await chips(page)})`);
await page.keyboard.down('Control'); await page.keyboard.press('KeyC'); await page.keyboard.press('KeyV'); await page.keyboard.up('Control');
await sleep(300);
check((await chips(page)) === n0 + 2, 'Ctrl+C / Ctrl+V pastes a copy');
await page.keyboard.press('Delete');
await sleep(300);
check((await chips(page)) === n0 + 1, 'Delete removes the selected copy');

// mouse drag moves the selected copy
let lay = await page.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
let sel = lay.instances.find((i) => i.id === lay.selectedId);
p = toPx(sel.x, sel.y);
await page.mouse.move(p.x, p.y); await page.mouse.down();
await page.mouse.move(p.x + 20 * s, p.y, { steps: 5 }); await page.mouse.move(p.x + 20 * s, p.y + 10 * s, { steps: 5 });
await page.mouse.up();
await sleep(300);
lay = await page.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
const moved = lay.instances.find((i) => i.id === sel.id);
check(Math.abs(moved.x - sel.x - 20) < 0.6 && Math.abs(moved.y - sel.y + 10) < 0.6, `mouse drag moves the copy by (+20, -10) mm (got ${(moved.x - sel.x).toFixed(2)}, ${(moved.y - sel.y).toFixed(2)})`);

// scale input keeps aspect
const aspect = (i) => i.scaleY / i.scale;
const w0 = await page.$$eval('.field', (fs) => fs.find((f) => f.textContent.startsWith('Width'))?.querySelector('input').value);
const widthInput = await page.evaluateHandle(() => [...document.querySelectorAll('.field')].find((f) => f.textContent.startsWith('Width')).querySelector('input'));
await widthInput.click({ clickCount: 3 }); await widthInput.type('60'); await page.keyboard.press('Enter');
await sleep(300);
lay = await page.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
sel = lay.instances.find((i) => i.id === lay.selectedId);
check(Math.abs(aspect(sel) - 1) < 1e-9, `width input with aspect lock keeps scaleY/scale = 1 (width ${w0} -> 60)`);

// grid 2 x 3 on A4 paper
await page.select('select[aria-label="Paper size"]', 'a5');
await sleep(200);
await clickText(page, 'button', '✛ Center paper');
const setNum = async (label, v) => {
  const h = await page.evaluateHandle((label) => [...document.querySelectorAll('.field')].find((f) => f.querySelector('.field-label')?.textContent.trim() === label).querySelector('input'), label);
  await h.click(); await sleep(50);
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await h.type(String(v)); await page.keyboard.press('Enter'); await sleep(150);
};
await setNum('Rows', 3); await setNum('Columns', 2);
await clickText(page, 'button', '▦ Make');
await sleep(500);
check((await chips(page)) === 6, `grid makes 3 x 2 = 6 copies (${await chips(page)})`);
if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-grid.png` });
// Chrome asks before a page's 2nd download ("download multiple files"), which headless can't answer,
// so export the board from a fresh tab (the layout is persisted, so it's the same board).
const page2 = await openPage({ width: 1280, height: 1300 }, { clear: false });
const dl2 = mkdtempSync(join(tmpdir(), 'penplot-dl2-'));
await (await page2.createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl2 });
check((await chips(page2)) === 6, 'fresh tab loads the same 6-copy board from localStorage');
await clickText(page2, 'button', '⬇ Download');
file = await waitDownload(dl2, []);
if (file) file = join('..', dl2.split('/').pop(), file);
body = file ? readFileSync(join(dl, file), 'utf8') : '';
await page2.close();
check(!!file && file.endsWith('.gcode') && body.includes('; Copies on the board: 6'), `multi-copy export is one .gcode file with 6 copies (${file})`);
// every travel followed by pen down + dwell
const lines = body.split('\n').map((l) => l.replace(/;.*/, '').trim()).filter(Boolean);
let bad = 0;
lines.forEach((l, i) => { if (/^G0 X/.test(l) && lines.slice(i + 1).some((k) => /^G1 X/.test(k)) && !(/^G1 Z/.test(lines[i + 1]) && /^G4 P/.test(lines[i + 2]))) bad++; });
check(bad === 0, 'every travel in the multi-copy file is followed by pen-down + dwell');

// persistence
await page.reload({ waitUntil: 'networkidle0' });
await sleep(400);
check((await chips(page)) === 6, 'layout persists after reload');
await page.close();

// ---------------------------------------------------------------- phone (touch + share)
const phone = await openPage({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { stubShare: true });
const shareBtn = await phone.$$eval('button', (bs) => bs.some((b) => b.textContent.includes('Share / Save to Files')));
check(shareBtn, 'Share / Save to Files button shows when navigator.canShare({files}) is supported');
await clickText(phone, 'button', '⇪ Share');
await sleep(300);
const shared = await phone.evaluate(() => window.__shared);
check(shared.length === 1 && shared[0].name.endsWith('.gcode') && shared[0].type === 'application/octet-stream' && shared[0].head.startsWith('; ===='), `shared File: ${JSON.stringify(shared[0] && { name: shared[0].name, type: shared[0].type })}`);
const hint = await phone.$$eval('.note.hint', (n) => n.map((x) => x.textContent).join(' '));
check(/rename it in the Files app/.test(hint), 'rename hint is shown next to the export button');
// touch drag
const pbox = await phone.$eval('canvas.bed', (c) => { const r = c.getBoundingClientRect(); return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width }; });
await phone.evaluate((y) => window.scrollTo(0, y - 20), pbox.y);
await sleep(200);
const vb = await phone.$eval('canvas.bed', (c) => { const r = c.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
const ps = (vb.w - 2 * pad) / 220;
let pl = await phone.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
const t0 = pl.instances[0];
const tp = { x: vb.x + pad + t0.x * ps, y: vb.y + pad + (220 - t0.y) * ps };
await phone.touchscreen.touchStart(tp.x, tp.y);
for (let k = 1; k <= 6; k++) await phone.touchscreen.touchMove(tp.x - (k * 15 * ps) / 6, tp.y);
await phone.touchscreen.touchEnd();
await sleep(300);
pl = await phone.evaluate(() => JSON.parse(localStorage.getItem('penplot.layout.v1')));
const t1 = pl.instances.find((i) => i.id === t0.id);
check(Math.abs(t1.x - t0.x + 15) < 1, `touch drag moves the copy (${(t1.x - t0.x).toFixed(2)} mm in X)`);
if (SHOTS) await phone.screenshot({ path: `${SHOTS}/e2e-phone.png`, fullPage: false });

check(errors.length === 0, `no page errors ${errors.length ? JSON.stringify(errors) : ''}`);
await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll e2e checks passed');
process.exit(failures ? 1 : 0);
