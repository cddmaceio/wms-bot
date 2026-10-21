// Endpoint observado no WMS: a tela separation-details consulta PalletItem/get-all.
function isSeparationQuery(request, dateBr) {
  if (!['xhr', 'fetch'].includes(request.resourceType()) || request.method() !== 'GET') return false;
  let url;
  try { url = new URL(request.url()); } catch { return false; }
  if (!/\/outbound-reports\/api\/PalletItem\/get-all\/?$/i.test(url.pathname)) return false;
  const iso = dateBr.split('/').reverse().join('-');
  // O WMS observado usa "AAAA-MM-DD HH:mm:ss"; também aceita ISO com T.
  const matchesDate = value => value === dateBr || value === iso || value?.startsWith(iso + 'T') || value?.startsWith(iso + ' ');
  return !!(matchesDate(url.searchParams.get('initialDate')) && matchesDate(url.searchParams.get('finalDate')));
}

async function waitForQuery(page, click, dateBr, timeout = 60000) {
  const requests = new Set();
  let timer, resolveResponse, rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const onRequest = request => {
    if (isSeparationQuery(request, dateBr)) {
      requests.add(request);
      console.log('[FILTER] Consulta PalletItem/get-all iniciada com as duas datas confirmadas');
    }
  };
  const onResponse = result => { if (requests.has(result.request())) resolveResponse(result); };
  const onFailed = request => {
    if (!requests.has(request)) return;
    const reason = request.failure()?.errorText || '';
    // O Angular pode cancelar uma consulta intermediária ao iniciar a definitiva.
    if (!/aborted|cancelled|canceled/i.test(reason)) rejectResponse(new Error('FILTER_QUERY_FAILED | A requisição da consulta WMS falhou'));
  };
  const onClose = () => rejectResponse(new Error('FILTER_QUERY_CLOSED | Página encerrada durante a consulta'));
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  page.on('close', onClose);
  try {
    const work = (async () => {
      const [result] = await Promise.all([response, Promise.resolve().then(click)]);
      if (!result.ok()) throw new Error(`FILTER_RESPONSE | A consulta WMS retornou HTTP ${result.status()}`);
      if (await result.finished()) throw new Error('FILTER_RESPONSE | Transferência da consulta interrompida');
      console.log(`[FILTER] Consulta concluída: HTTP ${result.status()} | período ${dateBr}`);
      return result;
    })();
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`FILTER_QUERY_TIMEOUT | Consulta PalletItem/get-all sem conclusão em ${timeout}ms; requisições correspondentes: ${requests.size}`)), timeout);
    })]);
  } finally {
    clearTimeout(timer);
    page.removeListener('request', onRequest);
    page.removeListener('response', onResponse);
    page.removeListener('requestfailed', onFailed);
    page.removeListener('close', onClose);
  }
}

// Confirma o período e aguarda a conclusão observável da consulta.
async function applyDateFilter(page, dateBr) {
  const selectors = [
    "input.datepicker-tracking",
    'input[class*="datepicker"]',
    'input[placeholder*="dd/mm" i]',
    'input[placeholder*="data" i]',
  ];
  let fields;
  for (const selector of selectors) {
    const all = page.locator(selector);
    const visible = [];
    for (let i = 0; i < (await all.count()); i++)
      if (await all.nth(i).isVisible()) visible.push(all.nth(i));
    if (visible.length === 2) {
      fields = visible;
      break;
    }
  }
  if (!fields)
    throw new Error(
      "FILTER_FIELDS | Esperados dois campos visíveis do período",
    );
  for (const input of fields) {
    await input.scrollIntoViewIfNeeded();
    await input.click();
    try {
      await input.fill(dateBr, { timeout: 3000 });
    } catch {
      await input.press("ControlOrMeta+A");
      await input.pressSequentially(dateBr, { delay: 80 });
    }
    await input.press("Tab");
  }
  for (const field of fields)
    if ((await field.inputValue()).trim() !== dateBr)
      throw new Error("FILTER_VALUE | Data do período divergente");
  const button = page.getByRole("button", {
    name: /^(Consultar|Buscar|Pesquisar|Filtrar)$/i,
  });
  let target;
  for (let i = 0; i < (await button.count()); i++)
    if (
      (await button.nth(i).isVisible()) &&
      (await button.nth(i).isEnabled())
    ) {
      target = button.nth(i);
      break;
    }
  if (!target)
    throw new Error("FILTER_QUERY | Botão de consulta não encontrado");
  await waitForQuery(page, () => target.click({ timeout: 10000 }), dateBr);
  await page.waitForFunction(
    selector => !Array.from(document.querySelectorAll(selector)).some(element =>
      element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden'),
    '.p-datatable-loading-overlay, .loading-overlay, .p-progress-spinner',
    { timeout: 60000 },
  );
  for (const field of fields)
    if ((await field.inputValue()).trim() !== dateBr)
      throw new Error("FILTER_CHANGED | Período alterado durante a consulta");
  return true;
}
module.exports = { applyDateFilter, isSeparationQuery, waitForQuery };
