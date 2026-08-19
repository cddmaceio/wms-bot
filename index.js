// Fuso horário de Brasília (UTC-3) — o container pode iniciar em UTC
process.env.TZ = process.env.APP_TIMEZONE || 'America/Maceio';

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ── Config ───────────────────────────────────────────────────
const SESSION_FILE = process.env.SESSION_FILE || '/data/wms-profile/storageState.json';
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || '/data/downloads';
const WMS_URL      = process.env.WMS_URL      || 'https://wmst2.ambev.com.br/wmsnew';
const WMS_USER     = process.env.WMS_USER     || '';
const WMS_PASS     = process.env.WMS_PASS     || '';
const PORT         = process.env.PORT         || 3001;

// ── Integração com o backend de conferência de carga ────────
// URL base do backend (ex: http://conferencia-backend:3001 ou https://api.exemplo.com)
const APP_API_URL    = process.env.APP_API_URL    || '';
// Endpoint de upload do backend (não usa mais Supabase Edge Function)
const APP_API_ENDPOINT = process.env.APP_API_ENDPOINT || '/api/conference/upload';
// Tamanho do lote para envio (o backend já faz batch de 500 internamente)
const APP_API_BATCH  = parseInt(process.env.APP_API_BATCH || '2000');

const URL_LOGIN          = `${WMS_URL}/multiple-realms`;
const URL_SEPARACAO      = `${WMS_URL}/separation-details`;
const URL_SEPARACAO_ALTS = [
  `${WMS_URL}/separation-details`,
  `${WMS_URL}/#/separation/separation-details`,
  `${WMS_URL}/#/separation-details`,
];

// ── Helpers ──────────────────────────────────────────────────
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getStorageStateIfExists() {
  return fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// Data de hoje no fuso configurado (Brasília), em formato ISO yyyy-mm-dd
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDateBR(input) {
  if (!input) {
    const d = new Date();
    return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [y, m, d] = input.split('-');
    return `${d}/${m}/${y}`;
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) return input;
  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
}

function normalizeFileDate(input) {
  if (!input) return todayISO();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
    const [d, m, y] = input.split('/');
    return `${y}-${m}-${d}`;
  }
  throw new Error('INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy');
}

function getCsvFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.toLowerCase().endsWith('.csv'))
    .map(f => {
      const fp = path.join(DOWNLOAD_DIR, f);
      const s  = fs.statSync(fp);
      return { name: f, fullPath: fp, mtimeMs: s.mtimeMs, size: s.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function getPngFilesSorted() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return [];
  return fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .map(f => {
      const fp = path.join(DOWNLOAD_DIR, f);
      const s  = fs.statSync(fp);
      return { name: f, fullPath: fp, mtimeMs: s.mtimeMs, size: s.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function deleteAllManagedFiles() {
  const files = [...getCsvFilesSorted(), ...getPngFilesSorted()];
  let deleted = 0; const deletedFiles = []; const failedFiles = [];
  for (const f of files) {
    try { fs.unlinkSync(f.fullPath); deleted++; deletedFiles.push(f.name); }
    catch (e) { failedFiles.push({ name: f.name, error: e.message }); }
  }
  return { totalFound: files.length, deleted, deletedFiles, failedFiles };
}

async function saveScreenshot(page, prefix = 'debug') {
  try {
    ensureDir(DOWNLOAD_DIR);
    const safe = prefix.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const fp   = path.join(DOWNLOAD_DIR, `${safe}-${Date.now()}.png`);
    await page.screenshot({ path: fp, fullPage: true });
    // Mantém só a mais recente
    for (const old of getPngFilesSorted()) {
      if (old.fullPath !== fp) { try { fs.unlinkSync(old.fullPath); } catch(_){} }
    }
    return fp;
  } catch (e) {
    console.error('Screenshot error:', e.message);
    return null;
  }
}

async function logPage(page, label) {
  console.log(`===== ${label} =====`);
  console.log('URL:', page.url());
  console.log('Title:', await page.title().catch(() => '?'));
}

// ── Login WMS ────────────────────────────────────────────────
async function doLogin(page, user, pass) {
  console.log('[LOGIN] Navegando para multiple-realms...');
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(3000);

  await logPage(page, 'Login Page - Multiple Realms');
  await saveScreenshot(page, 'login-realms');

  // ── Passo 1: clicar em "Login com Credenciais" (3ª opção) ──
  const realmCandidates = [
    page.locator('button:has-text("Login com Credenciais")').first(),
    page.locator('a:has-text("Login com Credenciais")').first(),
    page.locator('button:has-text("Credenciais")').first(),
    page.locator('a:has-text("Credenciais")').first(),
    // fallback: terceiro botão/link clicável da tela
    page.locator('button').nth(2),
  ];
  let realmClicked = false;
  for (const btn of realmCandidates) {
    try {
      if (await btn.count() && await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        realmClicked = true;
        console.log('[LOGIN] "Login com Credenciais" clicado');
        break;
      }
    } catch (_) {}
  }
  if (!realmClicked) {
    await saveScreenshot(page, 'login-realm-not-found');
    throw new Error('LOGIN_REALM_BUTTON_NOT_FOUND | Botão "Login com Credenciais" não encontrado');
  }

  // Aguarda formulário de credenciais aparecer
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(2500);
  await logPage(page, 'Credentials Form');
  await saveScreenshot(page, 'login-credentials-form');

  // Diagnóstico: loga todos os inputs encontrados
  const allInputs = await page.locator('input').all();
  console.log(`[LOGIN] Total inputs encontrados: ${allInputs.length}`);
  for (let i = 0; i < allInputs.length; i++) {
    const type        = await allInputs[i].getAttribute('type').catch(() => '?');
    const name        = await allInputs[i].getAttribute('name').catch(() => '?');
    const id          = await allInputs[i].getAttribute('id').catch(() => '?');
    const placeholder = await allInputs[i].getAttribute('placeholder').catch(() => '?');
    const formcontrol = await allInputs[i].getAttribute('formcontrolname').catch(() => '?');
    console.log(`[LOGIN] input[${i}] type=${type} id=${id} name=${name} placeholder=${placeholder} formcontrolname=${formcontrol}`);
  }

  // Tenta múltiplos seletores para o campo usuário (Angular usa formcontrolname)
  let userInput = null;
  const userSelectors = [
    'input[formcontrolname="user"]',
    'input[formcontrolname="username"]',
    'input[formcontrolname="login"]',
    'input[formcontrolname="usuario"]',
    'input[id*="user" i]',
    'input[id*="login" i]',
    'input[id*="usuario" i]',
    'input[name*="user" i]',
    'input[name*="login" i]',
    'input[placeholder*="suário" i]',
    'input[placeholder*="suario" i]',
    'input[placeholder*="login" i]',
    'input[placeholder*="user" i]',
    // Fallback: primeiro input não-password e não-hidden visível
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
  ];

  for (const sel of userSelectors) {
    try {
      const el = page.locator(sel).first();
      const count = await el.count();
      if (!count) continue;
      const visible = await el.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        userInput = el;
        console.log(`[LOGIN] Campo usuário encontrado com seletor: ${sel}`);
        break;
      }
    } catch (_) {}
  }

  if (!userInput) {
    const shot = await saveScreenshot(page, 'login-field-not-found');
    throw new Error(`LOGIN_USER_FIELD_NOT_FOUND | screenshot=${shot} | Veja os logs [LOGIN] input[N] para identificar o seletor correto`);
  }

  await userInput.scrollIntoViewIfNeeded().catch(() => {});
  await userInput.click({ timeout: 5000 });
  await userInput.fill(user);
  await sleep(500);

  // Senha
  const passInput = page.locator('input[type="password"]').first();
  await passInput.waitFor({ state: 'visible', timeout: 10000 });
  await passInput.click();
  await passInput.fill(pass);
  await sleep(500);

  // Botão Entrar
  const submitCandidates = [
    page.locator('button:has-text("Entrar")').first(),
    page.locator('button[type="submit"]').first(),
    page.locator('input[type="submit"]').first(),
    page.locator('button').last(),
  ];
  let clicked = false;
  for (const btn of submitCandidates) {
    try {
      if (await btn.count() && await btn.isVisible({ timeout: 1500 })) {
        await btn.click();
        clicked = true;
        console.log('[LOGIN] Botão Entrar clicado');
        break;
      }
    } catch (_) {}
  }
  if (!clicked) throw new Error('LOGIN_SUBMIT_BUTTON_NOT_FOUND');

  // Aguarda navegação pós-login
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(3000);

  await logPage(page, 'After Login');
  await saveScreenshot(page, 'after-login');
  return page.url();
}

async function isLoggedIn(page) {
  const url = page.url();
  if (url.includes('multiple-realms') || url.includes('/login')) return false;
  // Verifica se há elemento característico da sessão autenticada
  const nav = await page.locator('nav, .sidebar, [class*="menu"], [class*="nav"]').count().catch(() => 0);
  return nav > 0;
}

// ── Fecha modal de NPS se aparecer ─────────────────────────
async function dismissNpsModal(page) {
  try {
    // Verifica se o modal ambevtech-nps está presente
    const npsDiv = page.locator('#ambevtech-nps');
    const npsVisible = await npsDiv.isVisible({ timeout: 2000 }).catch(() => false);
    if (!npsVisible) return false;

    console.log('[NPS] Modal NPS detectado — tentando fechar...');

    // Seletores específicos do modal ambevtech-nps
    const candidates = [
      // Botão "Ask me later" dentro do modal NPS
      npsDiv.locator('button:has-text("Ask me later")').first(),
      npsDiv.locator('button:has-text("Later")').first(),
      npsDiv.locator('button:has-text("Agora não")').first(),
      npsDiv.locator('button:has-text("Fechar")').first(),
      npsDiv.locator('button:has-text("Send")').first(),
      // X de fechar
      npsDiv.locator('[aria-label="Close"]').first(),
      npsDiv.locator('button.close').first(),
      npsDiv.locator('button[class*="close"]').first(),
      npsDiv.locator('button[class*="dismiss"]').first(),
      npsDiv.locator('button[class*="later"]').first(),
      // Fallback global
      page.locator('button:has-text("Ask me later")').first(),
      page.locator('#ambevtech-nps button').last(),
    ];

    for (const btn of candidates) {
      try {
        if (await btn.count() && await btn.isVisible({ timeout: 1000 })) {
          await btn.click({ timeout: 3000 });
          console.log('[NPS] Modal NPS fechado via botão');
          await sleep(1200);
          return true;
        }
      } catch (_) {}
    }

    // Último recurso: pressiona Escape
    await page.keyboard.press('Escape');
    await sleep(800);
    const aindaVisivel = await npsDiv.isVisible({ timeout: 1000 }).catch(() => false);
    if (!aindaVisivel) {
      console.log('[NPS] Modal NPS fechado via Escape');
      return true;
    }

    // Força remoção via JS se tudo falhar
    await page.evaluate(() => {
      const el = document.getElementById('ambevtech-nps');
      if (el) el.remove();
    });
    console.log('[NPS] Modal NPS removido via JS');
    await sleep(500);
    return true;

  } catch (e) {
    console.log('[NPS] Erro ao fechar NPS:', e.message.slice(0, 80));
    return false;
  }
}

// Garante que o modal NPS não existe antes de qualquer clique importante
async function ensureNoNpsModal(page) {
  let tentativas = 0;
  while (tentativas < 3) {
    const npsVisible = await page.locator('#ambevtech-nps').isVisible({ timeout: 1000 }).catch(() => false);
    if (!npsVisible) break;
    console.log(`[NPS] Modal ainda visível — tentativa ${tentativas + 1} de fechar`);
    await dismissNpsModal(page);
    tentativas++;
  }
}

// ── Navegação para Detalhes da Separação ────────────────────
async function navegarSeparacao(page) {
  console.log('[NAV] Iniciando navegação para Detalhes da Separação...');
  await saveScreenshot(page, 'nav-inicio');

  // ── Estratégia 1: URLs diretas com hash (tenta variações) ──
  console.log('[NAV] Tentando URLs diretas...');
  for (const altUrl of URL_SEPARACAO_ALTS) {
    try {
      console.log('[NAV] Tentando:', altUrl);
      await page.goto(altUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(2500);
      await logPage(page, 'Nav URL direta');
      if (await onDetalhesPage(page)) {
        console.log('[NAV] Chegou via URL direta:', altUrl);
        return true;
      }
    } catch (e) {
      console.log('[NAV] URL falhou:', e.message.slice(0, 60));
    }
  }

  // Fecha modal NPS antes de tentar o menu
  await dismissNpsModal(page);

  // ── Estratégia 2: Menu lateral ──
  // O menu tem item pai "Separação" (com ícone de expandir) e submenu "Detalhes da Separação"
  // O item pai precisa ser clicado para expandir — mas o locator 'text=Separação' resolve
  // para itens de submenu ocultos. Precisamos clicar no item PAI do menu principal.
  console.log('[NAV] Tentando pelo menu lateral...');

  // Clica no item pai "Separação" no menu principal (não nos submenus ocultos)
  // Seletores específicos para menu pai — evita pegar submenus ocultos
  const menuPaiCandidates = [
    // Elemento de menu principal com label exata "Separação" (sem espaços extras)
    page.locator('.menu-item-label:text-is("Separação")').first(),
    page.locator('.nav-item-label:text-is("Separação")').first(),
    page.locator('li').filter({ has: page.locator(':text-is("Separação")') }).first(),
    // span/div com texto exato no menu lateral
    page.locator('span.menu-item-label:has-text("Separação")').first(),
    page.locator('span:text-is("Separação")').first(),
    page.locator('div:text-is("Separação")').first(),
  ];

  let menuExpandido = false;
  for (const candidato of menuPaiCandidates) {
    try {
      const count = await candidato.count();
      if (!count) continue;
      // Verifica se é visível (item pai deve estar visível, submenus não)
      const visible = await candidato.isVisible({ timeout: 2000 }).catch(() => false);
      if (!visible) continue;

      await candidato.scrollIntoViewIfNeeded().catch(() => {});
      await candidato.click({ timeout: 5000 });
      console.log('[NAV] Menu pai "Separação" clicado');
      await sleep(1500);
      menuExpandido = true;
      break;
    } catch (e) {
      console.log('[NAV] Candidato menu pai falhou:', e.message.slice(0, 80));
    }
  }

  if (!menuExpandido) {
    console.warn('[NAV] Não conseguiu expandir menu pai, tentando submenu diretamente...');
  }

  await saveScreenshot(page, 'nav-menu-expandido');

  // Agora clica em "Detalhes da Separação" no submenu (deve estar visível após expandir)
  const subMenuCandidates = [
    page.locator('.sub-menu-item-label:has-text("Detalhes da Separação")').first(),
    page.locator('span.sub-menu-item-label:has-text("Detalhes da Separação")').first(),
    page.locator('a:has-text("Detalhes da Separação")').first(),
    page.locator('li:has-text("Detalhes da Separação")').first(),
    page.locator(':text-is("Detalhes da Separação")').first(),
  ];

  for (const candidato of subMenuCandidates) {
    try {
      const count = await candidato.count();
      if (!count) continue;

      // Aguarda ficar visível (submenu pode ter animação de abertura)
      await candidato.waitFor({ state: 'visible', timeout: 5000 });
      await candidato.scrollIntoViewIfNeeded().catch(() => {});
      await candidato.click({ timeout: 8000 });
      console.log('[NAV] Submenu "Detalhes da Separação" clicado');
      await sleep(3000);

      if (await onDetalhesPage(page)) {
        console.log('[NAV] Navegação via menu concluída com sucesso');
        return true;
      }
    } catch (e) {
      console.log('[NAV] Candidato submenu falhou:', e.message.slice(0, 80));
    }
  }

  await saveScreenshot(page, 'nav-falhou');
  await logPage(page, 'Nav falhou');
  return false;
}

async function onDetalhesPage(page) {
  try {
    const url = page.url();
    // Verifica URL
    if (url.includes('separation-details') || url.includes('separacao-detalhes')) return true;
    // Verifica título da página
    const heading = await page.locator('h1, h2, .page-title, .content-title').first().innerText({ timeout: 3000 }).catch(() => '');
    if (heading.toLowerCase().includes('detalhes')) return true;
    // Verifica breadcrumb
    const breadcrumb = await page.locator('text=Detalhes da Separação').count().catch(() => 0);
    return breadcrumb > 0;
  } catch {
    return false;
  }
}

// ── Preenchimento de filtros e download ─────────────────────
async function setDateFilter(page, dateBr) {
  console.log('[FILTER] Configurando data:', dateBr);

  // Fecha NPS antes de mexer nos filtros
  await ensureNoNpsModal(page);

  // Diagnóstico: loga todos os inputs e p-calendars visíveis
  const allInputs = await page.locator('input').all();
  console.log(`[FILTER] Total inputs na página: ${allInputs.length}`);
  for (let i = 0; i < allInputs.length; i++) {
    const type        = await allInputs[i].getAttribute('type').catch(() => '?');
    const placeholder = await allInputs[i].getAttribute('placeholder').catch(() => '?');
    const formcontrol = await allInputs[i].getAttribute('formcontrolname').catch(() => '?');
    const ngmodel     = await allInputs[i].getAttribute('ng-model').catch(() => '?');
    const cls         = await allInputs[i].getAttribute('class').catch(() => '?');
    const visible     = await allInputs[i].isVisible().catch(() => false);
    console.log(`[FILTER] input[${i}] visible=${visible} type=${type} placeholder=${placeholder} formcontrolname=${formcontrol} class=${cls}`);
  }
  // Diagnóstico p-calendar especificamente
  const pCals = await page.locator('p-calendar').count().catch(() => 0);
  console.log(`[FILTER] p-calendar encontrados: ${pCals}`);
  // Diagnóstico: estrutura dos campos de período no topo da tela
  const periodoSection = await page.locator('text=PERÍODO, text=Período, text=periodo').count().catch(() => 0);
  console.log(`[FILTER] Label PERÍODO encontrado: ${periodoSection > 0}`);

  // Aguarda a página de Detalhes da Separação carregar os filtros
  await sleep(2000);

  // Os campos de data no WMS Detalhes da Separação usam class="datepicker-tracking"
  // São os inputs [3] e [4] na página (início e fim do período)
  const dateSelectors = [
    'input.datepicker-tracking',
    'input[class*="datepicker-tracking"]',
    // Fallbacks caso a classe mude
    'input[class*="datepicker"]',
    'input[placeholder*="dd/mm" i]',
    'input[placeholder*="data" i]',
  ];

  let filled = false;

  // Helper para preencher um input de p-calendar (PrimeNG não aceita fill() direto)
  async function fillDateInput(input, dateStr) {
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click({ timeout: 3000 }).catch(() => {});
    await sleep(200);
    // Triple-click seleciona tudo, depois digita
    await input.click({ clickCount: 3, timeout: 3000 }).catch(() => {});
    await sleep(100);
    // Tenta fill primeiro; se não funcionar, usa type caractere a caractere
    const filled1 = await input.fill(dateStr, { timeout: 2000 }).then(() => true).catch(() => false);
    if (!filled1) {
      await input.press('Control+A').catch(() => {});
      await input.press('Delete').catch(() => {});
      await input.type(dateStr, { delay: 100 });
    }
    await sleep(200);
    // Pressiona Tab para confirmar a data no p-calendar
    await input.press('Tab').catch(() => {});
    await sleep(400);
    const val = await input.inputValue().catch(() => '');
    return val;
  }

  for (const sel of dateSelectors) {
    try {
      const inputs = page.locator(sel);
      const count  = await inputs.count();
      if (!count) continue;

      // Preenche os dois primeiros campos visíveis (início e fim)
      let filledCount = 0;
      for (let i = 0; i < count && filledCount < 2; i++) {
        const input = inputs.nth(i);
        if (!(await input.isVisible().catch(() => false))) continue;

        const val = await fillDateInput(input, dateBr);
        console.log(`[FILTER] Campo ${i} preenchido com "${val}" | seletor: ${sel}`);
        filledCount++;
        filled = true;
      }

      if (filled) break;
    } catch (_) {}
  }

  if (!filled) {
    console.warn('[FILTER] Nenhum campo de data encontrado');
  }

  // Fecha NPS que pode ter aparecido
  await ensureNoNpsModal(page);

  // Clica em Consultar
  const consultarCandidates = [
    page.locator('button:has-text("Consultar")').first(),
    page.locator('button:has-text("Buscar")').first(),
    page.locator('button:has-text("Pesquisar")').first(),
    page.locator('button:has-text("Filtrar")').first(),
  ];
  for (const btn of consultarCandidates) {
    if (await btn.count() && await btn.isVisible().catch(() => false)) {
      await btn.click();
      await sleep(3000);
      console.log('[FILTER] Botão Consultar clicado');
      break;
    }
  }

  return filled;
}

// Remove qualquer overlay/modal que possa interceptar cliques
async function forceRemoveOverlays(page) {
  await page.evaluate(() => {
    // Remove NPS ambevtech
    ['#ambevtech-nps', 'ambevtech-nps', '[id*="nps"]'].forEach(sel => {
      document.querySelectorAll(sel).forEach(el => el.remove());
    });
    // Remove overlays/backdrops genéricos
    document.querySelectorAll('.modal-backdrop, .overlay, [class*="backdrop"], [class*="overlay"]').forEach(el => {
      el.style.pointerEvents = 'none';
      el.style.display = 'none';
    });
  }).catch(() => {});
}

async function clickDownloadBtn(page, fileDate) {
  console.log('[DOWNLOAD] Procurando botão de download...');

  // Remove overlays que possam bloquear cliques
  await forceRemoveOverlays(page);
  await sleep(500);

  // Log de diagnóstico: quantos div.content-button existem na tela?
  const totalBtns = await page.locator('div.content-button').count().catch(() => 0);
  console.log(`[DOWNLOAD] div.content-button encontrados na página: ${totalBtns}`);

  // Tenta cada content-button da última para a primeira (o de download costuma ser o último)
  for (let i = totalBtns - 1; i >= 0; i--) {
    try {
      const btn = page.locator('div.content-button').nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;

      await btn.scrollIntoViewIfNeeded().catch(() => {});
      // Remove overlays imediatamente antes de clicar
      await forceRemoveOverlays(page);
      await sleep(400);

      console.log(`[DOWNLOAD] Tentando content-button[${i}]...`);
      const downloadPromise = page.waitForEvent('download', { timeout: 25000 });

      // Tenta clique normal, fallback para clique via JS
      try {
        await btn.click({ timeout: 6000 });
      } catch {
        console.log(`[DOWNLOAD] Clique normal falhou, tentando via JS...`);
        await btn.evaluate(el => el.click());
      }

      const download = await downloadPromise;
      const ext = path.extname(download.suggestedFilename()) || '.csv';
      const fp  = path.join(DOWNLOAD_DIR, `wms-separacao-${fileDate}${ext}`);
      await download.saveAs(fp);
      console.log('[DOWNLOAD] Arquivo salvo:', fp);
      return { filePath: fp, suggestedFilename: download.suggestedFilename() };
    } catch (e) {
      console.log(`[DOWNLOAD] content-button[${i}] falhou:`, e.message.slice(0, 100));
    }
  }

  // Fallbacks adicionais
  const fallbacks = [
    page.locator('button[title*="xport" i]').first(),
    page.locator('button[title*="CSV" i]').first(),
    page.locator('[class*="content-button"]').first(),
    page.locator('a[download]').first(),
    page.locator('button .pi-download').locator('..').first(),
  ];

  for (const btn of fallbacks) {
    try {
      if (!(await btn.count())) continue;
      if (!(await btn.isVisible().catch(() => false))) continue;

      await forceRemoveOverlays(page);
      await sleep(300);

      const downloadPromise = page.waitForEvent('download', { timeout: 25000 });
      try {
        await btn.click({ timeout: 6000 });
      } catch {
        await btn.evaluate(el => el.click());
      }

      const download = await downloadPromise;
      const ext = path.extname(download.suggestedFilename()) || '.csv';
      const fp  = path.join(DOWNLOAD_DIR, `wms-separacao-${fileDate}${ext}`);
      await download.saveAs(fp);
      console.log('[DOWNLOAD] Arquivo salvo via fallback:', fp);
      return { filePath: fp, suggestedFilename: download.suggestedFilename() };
    } catch (e) {
      console.log('[DOWNLOAD] Fallback falhou:', e.message.slice(0, 100));
    }
  }

  return null;
}

// ── Envio para o backend de conferência (opcional) ──────────
// Transforma o CSV do WMS (separador ; e nomes PT-BR) para o formato da API
// Mapeamento colunas WMS (PT-BR) → campos da tabela base_ocp
const COL_MAP = {
  'código do armazém': 'codigo_armazem',
  'codigo do armazem': 'codigo_armazem',
  'mapas':             'mapas',
  'palete':            'palete',
  'caixa':             'caixa',
  'sequência':         'sequencia',
  'sequencia':         'sequencia',
  'status':            'status',
  'código do item':    'codigo_item',
  'codigo do item':    'codigo_item',
  'item':              'item',
  'qtd':               'qtd',
  'subtipo':           'subtipo',
  'categoria':         'categoria',
  'unidade':           'unidade',
  'origem':            'origem',
  'data de entrega':   'data_entrega',
  'placa':             'placa',
};

// Converte CSV do WMS em array de objetos prontos para o upsert
function parseCsvToRecords(filePath) {
  const raw   = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('CSV vazio');

  const sep = lines[0].includes(';') ? ';' : ',';
  const headers = lines[0].split(sep).map(h =>
    COL_MAP[h.trim().toLowerCase()] || h.trim().toLowerCase().replace(/\s+/g, '_')
  );
  console.log(`[API] Colunas mapeadas: ${headers.join(', ')}`);

  const raw_records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols   = lines[i].split(sep);
    const record = {};
    headers.forEach((col, idx) => { record[col] = (cols[idx] || '').trim(); });
    raw_records.push(record);
  }
  console.log(`[API] CSV parseado: ${raw_records.length} registros brutos`);

  // Deduplica pelo conflito: codigo_armazem + mapas + palete + codigo_item
  // O backend rejeita o batch inteiro se houver duplicatas na mesma chamada
  const seen = new Map();
  for (const r of raw_records) {
    const key = `${r.codigo_armazem}|${r.mapas}|${r.palete}|${r.codigo_item}`;
    seen.set(key, r); // última ocorrência vence (como um upsert)
  }
  const records = Array.from(seen.values());

  const dupes = raw_records.length - records.length;
  if (dupes > 0) {
    console.log(`[API] Duplicatas removidas: ${dupes} | Registros únicos: ${records.length}`);
  }

  return records;
}

async function sendToAppApi(filePath) {
  if (!APP_API_URL) {
    console.log('[API] APP_API_URL não configurado — envio pulado');
    return null;
  }

  const fileName = path.basename(filePath);
  const endpoint = `${APP_API_URL.replace(/\/$/, '')}${APP_API_ENDPOINT}`;
  console.log(`[API] Enviando ${fileName} para ${endpoint}...`);

  try {
    const records = parseCsvToRecords(filePath);
    if (!records.length) throw new Error('Nenhum registro no CSV');

    // O endpoint do backend espera { records, file_name }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records, file_name: fileName }),
    });

    let result;
    try   { result = await response.json(); }
    catch { result = { raw: await response.text() }; }

    // Loga o body completo para facilitar debug
    console.log('[API] Response body:', JSON.stringify(result));

    // Suporta o formato do backend { success, data: { processedCount, conferenceMapsUpserted } }
    // e mantém compatibilidade com o formato legado da Edge Function { success, inserted_count, maps_upserted, errors }
    const isNewBackend   = result.data && typeof result.data === 'object';
    const processedCount = isNewBackend ? result.data.processedCount         : result.total_processed;
    const mapsUpserted   = isNewBackend ? result.data.conferenceMapsUpserted : result.maps_upserted;
    const insertedCount  = isNewBackend ? result.data.processedCount         : result.inserted_count;
    const errorsCount    = isNewBackend ? 0                                  : (result.errors ?? 0);
    const ok             = response.ok && result.success;

    if (ok) {
      console.log(`[API] ✓ OK — maps: ${mapsUpserted ?? '?'} | inserted: ${insertedCount ?? '?'} | errors: ${errorsCount}`);
    } else {
      console.error(`[API] ✗ Falhou — status ${response.status} | inserted: ${insertedCount ?? '?'} | errors: ${errorsCount}`);
      if (result.error_details) {
        console.error('[API] Detalhes:', JSON.stringify(result.error_details));
      }
    }

    return {
      ok,
      status:        response.status,
      processed:     processedCount  ?? records.length,
      maps_upserted: mapsUpserted    ?? null,
      inserted:      insertedCount   ?? null,
      errors:        errorsCount     ?? null,
      message:       result.message  ?? null,
      error_details: result.error_details ?? null,
    };

  } catch (e) {
    console.error('[API] Erro:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Fluxo principal ──────────────────────────────────────────
async function runFlow(requestedDate) {
  const dateBr   = formatDateBR(requestedDate);
  const fileDate = normalizeFileDate(requestedDate);

  ensureDir(DOWNLOAD_DIR);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const storageState = getStorageStateIfExists();
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  });

  const page = await context.newPage();

  try {
    // Tenta navegar direto para a tela de separação com sessão salva
    if (storageState) {
      await page.goto(URL_SEPARACAO, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(2000);
    }

    // Verifica se está logado; se não, faz login
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      if (!WMS_USER || !WMS_PASS) {
        await browser.close();
        throw new Error('AUTH_REQUIRED | Configure WMS_USER e WMS_PASS nas variáveis de ambiente');
      }
      await doLogin(page, WMS_USER, WMS_PASS);

      // Salva sessão após login bem-sucedido
      ensureDir(path.dirname(SESSION_FILE));
      const state = await context.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
      console.log('[SESSION] StorageState salvo após login');
    }

    // Fecha modal de NPS se aparecer (surge após login ou ao navegar)
    await dismissNpsModal(page);

    // Navega para Detalhes da Separação
    const onPage = await navegarSeparacao(page);
    if (!onPage) {
      const shot = await saveScreenshot(page, 'nav-failed');
      throw new Error(`NAV_FAILED | Não foi possível chegar em Detalhes da Separação | screenshot=${shot}`);
    }

    await saveScreenshot(page, 'before-filter');

    // Aplica filtro de data e consulta
    const filtered = await setDateFilter(page, dateBr);
    if (!filtered) {
      console.warn('[FILTER] Campo de data não encontrado — tentando download sem filtro');
    }

    await saveScreenshot(page, 'after-filter');

    // Clica no botão de download
    const result = await clickDownloadBtn(page, fileDate);
    if (!result) {
      const shot = await saveScreenshot(page, 'download-failed');
      throw new Error(`DOWNLOAD_FAILED | Botão de download não encontrado | screenshot=${shot}`);
    }

    const successShot = await saveScreenshot(page, 'success');
    await context.close().catch(() => {});
    await browser.close().catch(() => {});

    // Envio para o backend se configurado
    const webhookResult = await sendToAppApi(result.filePath);

    return {
      success: true,
      file: result.filePath,
      suggestedFilename: result.suggestedFilename,
      dateUsed: dateBr,
      screenshot: successShot,
      upload: webhookResult,
    };
  } catch (error) {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

// ── UI ───────────────────────────────────────────────────────
function renderUI() {
  const csvFiles = getCsvFilesSorted();
  const pngFiles = getPngFilesSorted();
  const lastCsv  = csvFiles[0] || null;
  const lastPng  = pngFiles[0] || null;
  const hasSession = fs.existsSync(SESSION_FILE);
  const hasCredentials = !!(WMS_USER && WMS_PASS);

  const csvRows = csvFiles.slice(0, 10).map(f => `
    <tr>
      <td>${f.name}</td>
      <td class="num">${formatBytes(f.size)}</td>
      <td class="num">${new Date(f.mtimeMs).toLocaleString('pt-BR')}</td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">Nenhum CSV</td></tr>';

  const webhookConfigured = !!APP_API_URL;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WMS Bot · Detalhes da Separação</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg:       #0c0e14;
      --surface:  #13161f;
      --surface2: #1a1e2a;
      --border:   #252a38;
      --border2:  #2e3447;
      --amber:    #f59e0b;
      --amber-d:  #d97706;
      --amber-bg: rgba(245,158,11,0.08);
      --blue:     #3b82f6;
      --green:    #22c55e;
      --green-bg: rgba(34,197,94,0.08);
      --red:      #ef4444;
      --red-bg:   rgba(239,68,68,0.08);
      --text:     #e2e8f0;
      --muted:    #64748b;
      --muted2:   #94a3b8;
      --mono:     'IBM Plex Mono', monospace;
      --sans:     'IBM Plex Sans', sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      min-height: 100vh;
      line-height: 1.5;
    }

    /* ── Header ─── */
    .header {
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      padding: 0 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 56px;
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .logo {
      font-family: var(--mono);
      font-weight: 700;
      font-size: 15px;
      color: var(--amber);
      letter-spacing: 0.05em;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: blink 2s infinite; }
    @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
    .header-meta {
      font-family: var(--mono);
      font-size: 11px;
      color: var(--muted);
      display: flex;
      gap: 20px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 11px;
      font-family: var(--mono);
      font-weight: 500;
    }
    .badge-ok     { background: var(--green-bg); color: var(--green);  border: 1px solid rgba(34,197,94,0.2); }
    .badge-warn   { background: var(--amber-bg); color: var(--amber);  border: 1px solid rgba(245,158,11,0.2); }
    .badge-error  { background: var(--red-bg);   color: var(--red);    border: 1px solid rgba(239,68,68,0.2); }

    /* ── Layout ─── */
    .main { max-width: 1140px; margin: 0 auto; padding: 28px 24px; }

    /* ── Painel de ação ─── */
    .action-panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 640px) { .action-panel { grid-template-columns: 1fr; } }

    .action-left h2 {
      font-size: 14px;
      font-weight: 600;
      color: var(--muted2);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 16px;
      font-family: var(--mono);
    }
    .date-row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .date-input {
      background: var(--surface2);
      border: 1px solid var(--border2);
      color: var(--text);
      font-family: var(--mono);
      font-size: 14px;
      padding: 10px 14px;
      border-radius: 8px;
      outline: none;
      transition: border-color 0.15s;
    }
    .date-input:focus { border-color: var(--amber); }

    .btn {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 700;
      padding: 10px 20px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      white-space: nowrap;
    }
    .btn-primary { background: var(--amber); color: #000; }
    .btn-primary:hover:not(:disabled) { background: var(--amber-d); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-danger  { background: transparent; border: 1px solid var(--red); color: var(--red); }
    .btn-danger:hover:not(:disabled) { background: var(--red-bg); }
    .btn-ghost   { background: transparent; border: 1px solid var(--border2); color: var(--muted2); text-decoration: none; }
    .btn-ghost:hover { color: var(--text); border-color: var(--muted); }

    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }

    .action-right {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
    }
    .action-right h3 { font-size: 12px; color: var(--muted); font-family: var(--mono); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px; }
    .info-row { display: flex; justify-content: space-between; font-size: 13px; padding: 6px 0; border-bottom: 1px solid var(--border); }
    .info-row:last-child { border-bottom: none; }
    .info-label { color: var(--muted); }
    .info-val   { font-family: var(--mono); font-size: 12px; }

    /* ── Cards ─── */
    .grid-2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 {
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-family: var(--mono);
      margin-bottom: 14px;
    }
    .stat-big { font-size: 28px; font-weight: 700; color: var(--amber); font-family: var(--mono); }
    .stat-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }

    /* ── Tabela ─── */
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { font-family: var(--mono); font-size: 11px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; text-align: left; padding: 8px; border-bottom: 1px solid var(--border); }
    td { padding: 10px 8px; border-bottom: 1px solid var(--border); color: var(--muted2); font-family: var(--mono); font-size: 12px; }
    tr:last-child td { border-bottom: none; }
    .num { text-align: right; }
    .empty { text-align: center; color: var(--muted); padding: 20px; }

    /* ── Log / Output ─── */
    .log-box {
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      font-family: var(--mono);
      font-size: 12px;
      color: var(--muted2);
      white-space: pre-wrap;
      max-height: 260px;
      overflow-y: auto;
      display: none;
      margin-top: 16px;
    }
    .log-box.show { display: block; }
    .log-box .ok-line  { color: var(--green); }
    .log-box .err-line { color: var(--red); }
    .log-box .info-line { color: var(--amber); }

    /* ── Preview screenshot ─── */
    .preview-wrap {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 20px;
    }
    .preview-wrap h2 { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; font-family: var(--mono); margin-bottom: 14px; }
    .preview-img { width: 100%; max-height: 500px; object-fit: contain; border-radius: 8px; border: 1px solid var(--border2); }

    /* ── Progress ─── */
    .spinner {
      display: inline-block;
      width: 14px; height: 14px;
      border: 2px solid rgba(245,158,11,0.3);
      border-top-color: var(--amber);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

<header class="header">
  <div class="logo">
    <div class="logo-dot"></div>
    WMS BOT · Detalhes da Separação
  </div>
  <div class="header-meta">
    <span>${new Date().toLocaleString('pt-BR')}</span>
    <span class="badge ${hasSession ? 'badge-ok' : 'badge-warn'}">${hasSession ? '● Sessão OK' : '○ Sem sessão'}</span>
    <span class="badge ${hasCredentials ? 'badge-ok' : 'badge-error'}">${hasCredentials ? '● Credenciais OK' : '○ Sem credenciais'}</span>
    <span class="badge ${webhookConfigured ? 'badge-ok' : 'badge-warn'}">${webhookConfigured ? '● API OK' : '○ API não configurada'}</span>
  </div>
</header>

<main class="main">

  <div class="action-panel">
    <div class="action-left">
      <h2>Executar Download</h2>
      <div class="date-row">
        <input class="date-input" type="date" id="dateInput" value="${todayISO()}"/>
        <button class="btn btn-primary" id="runBtn" onclick="run()">
          <span id="runIcon">▶</span> Executar
        </button>
      </div>
      <div class="btn-row">
        <a class="btn btn-ghost" href="/download-last">⬇ Baixar último CSV</a>
        <a class="btn btn-ghost" href="/view-last-csv" target="_blank">👁 Ver CSV</a>
        <button class="btn btn-ghost" id="uploadBtn" onclick="uploadLast()" style="border-color:var(--green);color:var(--green)">↑ Reenviar para API</button>
        <button class="btn btn-danger" id="delBtn" onclick="deleteFiles()">✕ Limpar arquivos</button>
      </div>
      <div id="logBox" class="log-box"></div>
    </div>

    <div class="action-right">
      <h3>Status do ambiente</h3>
      <div class="info-row">
        <span class="info-label">WMS URL</span>
        <span class="info-val">${WMS_URL.replace('https://', '')}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Usuário configurado</span>
        <span class="info-val">${hasCredentials ? WMS_USER.slice(0,4) + '****' : '—'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Sessão salva</span>
        <span class="info-val" style="color:${hasSession ? 'var(--green)' : 'var(--amber)'}">${hasSession ? 'Sim' : 'Não'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Último CSV</span>
        <span class="info-val">${lastCsv ? lastCsv.name : '—'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">API destino</span>
        <span class="info-val">${APP_API_URL ? APP_API_URL.replace('https://','') : 'não configurado'}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Download dir</span>
        <span class="info-val">${DOWNLOAD_DIR}</span>
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>Último CSV</h2>
      <div class="stat-big">${lastCsv ? formatBytes(lastCsv.size) : '—'}</div>
      <div class="stat-sub">${lastCsv ? lastCsv.name : 'Nenhum arquivo encontrado'}</div>
      <div class="stat-sub" style="margin-top:4px">${lastCsv ? new Date(lastCsv.mtimeMs).toLocaleString('pt-BR') : ''}</div>
    </div>
    <div class="card">
      <h2>Histórico CSVs</h2>
      <table>
        <thead><tr><th>Arquivo</th><th>Tamanho</th><th class="num">Data</th></tr></thead>
        <tbody>${csvRows}</tbody>
      </table>
    </div>
  </div>

  ${lastPng ? `
  <div class="preview-wrap">
    <h2>Última screenshot do bot</h2>
    <img class="preview-img" src="/view-debug-last" alt="screenshot"/>
    <div style="margin-top:10px;display:flex;gap:8px">
      <a class="btn btn-ghost" href="/view-debug-last" target="_blank">🔍 Abrir em nova aba</a>
      <a class="btn btn-ghost" href="/download-debug-last">⬇ Baixar</a>
    </div>
  </div>` : ''}

  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
    <a class="btn btn-ghost" href="/health" target="_blank">Health</a>
    <a class="btn btn-ghost" href="/files" target="_blank">Files JSON</a>
    <a class="btn btn-ghost" href="/session-status" target="_blank">Session Status</a>
  </div>
</main>

<script>
  const runBtn  = document.getElementById('runBtn');
  const delBtn  = document.getElementById('delBtn');
  const logBox  = document.getElementById('logBox');
  const runIcon = document.getElementById('runIcon');

  function log(msg, type = '') {
    logBox.classList.add('show');
    const line = document.createElement('div');
    line.className = type ? type + '-line' : '';
    line.textContent = '[' + new Date().toLocaleTimeString('pt-BR') + '] ' + msg;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  async function run() {
    const date = document.getElementById('dateInput').value;
    runBtn.disabled = true;
    delBtn.disabled = true;
    runIcon.innerHTML = '<span class="spinner"></span>';
    logBox.innerHTML = '';
    logBox.classList.add('show');
    log('Iniciando fluxo WMS...', 'info');
    try {
      const res  = await fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      });
      const data = await res.json();
      if (data.success) {
        log('✓ Download concluído: ' + data.file, 'ok');
        if (data.upload?.ok) {
          log('✓ Upload OK — ' + (data.upload.maps_upserted ?? '?') + ' mapas | ' + (data.upload.processed ?? '?') + ' registros inseridos', 'ok');
          if (data.upload.errors) log('⚠ ' + data.upload.errors + ' erros no upsert', 'info');
        } else if (data.upload?.ok === false) {
          log('✗ Upload falhou: ' + (data.upload.error || 'status ' + data.upload.status), 'err');
        } else if (!data.upload) {
          log('ℹ APP_API_URL não configurado — upload pulado', '');
        }
        setTimeout(() => location.reload(), 1500);
      } else {
        log('✗ Erro: ' + (data.error || 'Falha desconhecida'), 'err');
      }
    } catch (e) {
      log('✗ Erro de conexão: ' + e.message, 'err');
    } finally {
      runBtn.disabled = false;
      delBtn.disabled = false;
      runIcon.textContent = '▶';
    }
  }

  async function uploadLast() {
    const btn = document.getElementById('uploadBtn');
    btn.disabled = true;
    log('Enviando CSV para a API...', 'info');
    try {
      const res  = await fetch('/upload-last', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        log('✓ Upload OK — ' + (data.maps_upserted ?? '?') + ' mapas | ' + (data.processed ?? '?') + ' registros | arquivo: ' + data.file, 'ok');
        if (data.errors) log('⚠ ' + data.errors + ' erros no upsert', '');
      } else {
        log('✗ Upload falhou: ' + (data.error || JSON.stringify(data)), 'err');
      }
    } catch (e) {
      log('✗ Erro: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteFiles() {
    if (!confirm('Apagar todos os CSVs e screenshots?')) return;
    delBtn.disabled = true;
    log('Apagando arquivos...', 'info');
    try {
      const res  = await fetch('/delete-files', { method: 'POST' });
      const data = await res.json();
      log('✓ Deletados: ' + data.deleted + ' arquivo(s)', 'ok');
      setTimeout(() => location.reload(), 1000);
    } catch (e) {
      log('✗ Erro: ' + e.message, 'err');
    } finally {
      delBtn.disabled = false;
    }
  }
</script>
</body>
</html>`;
}

// ── Rotas ────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  ensureDir(DOWNLOAD_DIR);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderUI());
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'wms-bot',
    sessionFileExists: fs.existsSync(SESSION_FILE),
    credentialsConfigured: !!(WMS_USER && WMS_PASS),
    webhookConfigured: !!APP_API_URL,
    now: new Date().toISOString(),
  });
});

app.get('/session-status', (_req, res) => {
  res.json({
    authenticated: fs.existsSync(SESSION_FILE),
    sessionFile: SESSION_FILE,
  });
});

app.post('/run', async (req, res) => {
  try {
    const result = await runFlow(req.body?.date || null);
    return res.json(result);
  } catch (error) {
    console.error('[RUN] Error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/delete-files', (_req, res) => {
  ensureDir(DOWNLOAD_DIR);
  const result = deleteManagedFiles();
  res.json({ success: true, ...result });
});

function deleteManagedFiles() {
  const files = [...getCsvFilesSorted(), ...getPngFilesSorted()];
  let deleted = 0; const deletedFiles = []; const failedFiles = [];
  for (const f of files) {
    try { fs.unlinkSync(f.fullPath); deleted++; deletedFiles.push(f.name); }
    catch (e) { failedFiles.push({ name: f.name, error: e.message }); }
  }
  return { totalFound: files.length, deleted, deletedFiles, failedFiles };
}

app.get('/files', (_req, res) => {
  const files = getCsvFilesSorted().map(f => ({
    name: f.name,
    size: f.size,
    modifiedAt: new Date(f.mtimeMs).toISOString(),
    path: f.fullPath,
  }));
  res.json({ ok: true, total: files.length, files });
});

app.get('/download-last', (_req, res) => {
  const files = getCsvFilesSorted();
  if (!files.length) return res.status(404).json({ error: 'NO_FILES_FOUND' });
  return res.download(files[0].fullPath, files[0].name);
});

// Reenvia o último CSV baixado para a API do app (sem precisar baixar de novo)
app.post('/upload-last', async (_req, res) => {
  const files = getCsvFilesSorted();
  if (!files.length) return res.status(404).json({ ok: false, error: 'NO_CSV_FOUND' });
  if (!APP_API_URL) return res.status(400).json({ ok: false, error: 'APP_API_URL_NOT_CONFIGURED' });

  console.log('[API] Reenvio manual do último CSV:', files[0].name);
  const result = await sendToAppApi(files[0].fullPath);
  const { ok, ...rest } = result ?? {};
  return res.json({ ok: ok ?? false, file: files[0].name, ...rest });
});

app.get('/view-last-csv', (_req, res) => {
  const files = getCsvFilesSorted();
  if (!files.length) return res.status(404).send('Nenhum CSV encontrado');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return fs.createReadStream(files[0].fullPath).pipe(res);
});

app.get('/download-debug-last', (_req, res) => {
  const files = getPngFilesSorted();
  if (!files.length) return res.status(404).json({ error: 'NO_DEBUG_FILES_FOUND' });
  return res.download(files[0].fullPath, files[0].name);
});

app.get('/view-debug-last', (_req, res) => {
  const files = getPngFilesSorted();
  if (!files.length) return res.status(404).send('Nenhuma screenshot');
  res.setHeader('Content-Type', 'image/png');
  return fs.createReadStream(files[0].fullPath).pipe(res);
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`wms-bot running on port ${PORT}`);
  console.log(`WMS URL: ${WMS_URL}`);
  console.log(`User: ${WMS_USER ? WMS_USER.slice(0,4)+'****' : 'NOT SET'}`);
  console.log(`App API: ${APP_API_URL || 'not configured'}`);
});
