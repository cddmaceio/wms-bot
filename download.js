const path = require('path');

function downloadTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 60000;
}

// Register before clicking and always remove the listener, including on click failure.
async function waitForDownload(page, click, timeout) {
  let timer;
  let onDownload;
  const pending = new Promise((resolve, reject) => {
    onDownload = resolve;
    page.on('download', onDownload);
    timer = setTimeout(() => reject(new Error(`Nenhum download iniciado em ${timeout}ms`)), timeout);
  });
  try {
    const [download] = await Promise.all([pending, Promise.resolve().then(click)]);
    return download;
  } finally {
    clearTimeout(timer);
    page.removeListener('download', onDownload);
  }
}

async function clickDownload(page, fileDate, { downloadDir, removeOverlays, timeout }) {
  timeout = downloadTimeout(timeout);
  await removeOverlays(page);
  const controls = page.locator('button, a, [role="button"], div.content-button:not(:has(button, a, [role="button"]))');
  const candidates = await controls.evaluateAll(elements => elements.map((el, index) => {
    const label = [el.textContent, el.getAttribute('title'), el.getAttribute('aria-label'),
      el.getAttribute('data-tooltip'), el.getAttribute('ptooltip'), el.getAttribute('class'),
      ...Array.from(el.querySelectorAll('[class], [title], [aria-label]')).map(child =>
        [child.getAttribute('class'), child.getAttribute('title'), child.getAttribute('aria-label')].join(' '))
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const score = /download|export|baixar|csv|excel|file-excel|file-csv|cloud_download|save_alt|file_download/i.test(label)
      || el.hasAttribute('download') ? 2 : el.matches('div.content-button') ? 1 : 0;
    return { index, label: label.slice(0, 180), score };
  }).filter(item => item.score).sort((a, b) => b.score - a.score || b.index - a.index));

  console.log(`[DOWNLOAD] ${candidates.length} candidatos; prazo por tentativa: ${timeout}ms`);
  for (const candidate of candidates) {
    const btn = controls.nth(candidate.index);
    if (!(await btn.isVisible().catch(() => false))) continue;
    if (!(await btn.isEnabled().catch(() => false))) {
      console.log(`[DOWNLOAD] Controle desabilitado: ${candidate.label}`);
      continue;
    }
    try {
      await removeOverlays(page);
      await btn.scrollIntoViewIfNeeded();
      console.log(`[DOWNLOAD] Tentando controle[${candidate.index}]: ${candidate.label}`);
      const download = await waitForDownload(page, () => btn.click({ timeout: 6000 }), timeout);
      const suggestedFilename = download.suggestedFilename();
      const ext = path.extname(suggestedFilename) || '.csv';
      const filePath = path.join(downloadDir, `wms-separacao-${fileDate}${ext}`);
      // A save failure must not trigger another export of the same report.
      try {
        await download.saveAs(filePath);
      } catch (error) {
        throw new Error(`DOWNLOAD_SAVE_FAILED | ${error.message}`);
      }
      console.log('[DOWNLOAD] Arquivo salvo:', filePath);
      return { filePath, suggestedFilename };
    } catch (error) {
      if (error.message.startsWith('DOWNLOAD_SAVE_FAILED')) throw error;
      console.log(`[DOWNLOAD] Controle[${candidate.index}] falhou: ${error.message.slice(0, 240)}`);
    }
  }
  return null;
}

module.exports = { clickDownload, waitForDownload, downloadTimeout };
