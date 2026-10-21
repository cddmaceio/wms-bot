// Automação extraída do bot original; configuração isolada por execução.
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { firstVisible, waitForLogin } = require("../login");
module.exports = async function downloadWms(
  config,
  directory,
  sessionFile,
  date,
  signal,
) {
  const DOWNLOAD_DIR = directory;
  const SESSION_FILE = sessionFile;
  const WMS_USER = config.wmsUser;
  const WMS_PASS = config.wmsPass;
  const WMS_URL = config.wmsUrl.replace(/\/$/, "");
  const URL_LOGIN = WMS_URL + "/multiple-realms";
  const URL_SEPARACAO = WMS_URL + "/separation-details";
  const URL_SEPARACAO_ALTS = [
    URL_SEPARACAO,
    WMS_URL + "/#/separation/separation-details",
    WMS_URL + "/#/separation-details",
  ];
  function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function getStorageStateIfExists() {
    return fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined;
  }

  function formatDateBR(input) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      const [y, m, d] = input.split("-");
      return `${d}/${m}/${y}`;
    }
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) return input;
    throw new Error("INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy");
  }

  function normalizeFileDate(input) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(input)) {
      const [d, m, y] = input.split("/");
      return `${y}-${m}-${d}`;
    }
    throw new Error("INVALID_DATE_FORMAT | use yyyy-mm-dd ou dd/mm/yyyy");
  }

  function getPngFilesSorted() {
    if (!fs.existsSync(DOWNLOAD_DIR)) return [];
    return fs
      .readdirSync(DOWNLOAD_DIR)
      .filter((f) => f.toLowerCase().endsWith(".png"))
      .map((f) => {
        const fp = path.join(DOWNLOAD_DIR, f);
        const s = fs.statSync(fp);
        return { name: f, fullPath: fp, mtimeMs: s.mtimeMs, size: s.size };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async function saveScreenshot(page, prefix = "debug") {
    try {
      ensureDir(DOWNLOAD_DIR);
      const safe = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const fp = path.join(DOWNLOAD_DIR, `${safe}-${Date.now()}.png`);
      await page.screenshot({ path: fp, fullPage: true });
      // Mantém só a mais recente
      for (const old of getPngFilesSorted()) {
        if (old.fullPath !== fp) {
          try {
            fs.unlinkSync(old.fullPath);
          } catch (_) {}
        }
      }
      return fp;
    } catch (e) {
      console.error("Screenshot error:", e.message);
      return null;
    }
  }

  async function logPage(page, label) {
    console.log(`===== ${label} =====`);
    const current = new URL(page.url());
    console.log("URL:", current.origin + current.pathname);
    console.log("Title:", await page.title().catch(() => "?"));
  }

  // ── Login WMS ────────────────────────────────────────────────
  async function doLogin(page, user, pass) {
    console.log("[LOGIN] Navegando para multiple-realms...");
    await page.goto(URL_LOGIN, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
    await sleep(3000);

    await logPage(page, "Login Page - Multiple Realms");
    await saveScreenshot(page, "login-realms");

    // ── Passo 1: clicar em "Login with credentials" / "Login com Credenciais" ──
    // O WMS pode responder em inglês mesmo quando o restante do bot está em português.
    const realmCandidates = [
      page
        .getByRole("button", {
          name: /login\s+(with\s+)?credentials|login\s+com\s+credenciais/i,
        })
        .first(),
      page
        .getByRole("link", {
          name: /login\s+(with\s+)?credentials|login\s+com\s+credenciais/i,
        })
        .first(),
      page.locator('button:has-text("Login com Credenciais")').first(),
      page.locator('a:has-text("Login com Credenciais")').first(),
      page.locator('button:has-text("Login with credentials")').first(),
      page.locator('a:has-text("Login with credentials")').first(),
      page.locator('button:has-text("Credenciais")').first(),
      page.locator('a:has-text("Credenciais")').first(),
    ];
    let realmClicked = false;
    for (const btn of realmCandidates) {
      try {
        if ((await btn.count()) && (await btn.isVisible({ timeout: 2000 }))) {
          await btn.click();
          realmClicked = true;
          console.log("[LOGIN] Opção de login por credenciais clicada");
          break;
        }
      } catch (_) {}
    }
    if (!realmClicked) {
      await saveScreenshot(page, "login-realm-not-found");
      throw new Error(
        'LOGIN_REALM_BUTTON_NOT_FOUND | Botão "Login com Credenciais" não encontrado',
      );
    }

    // Aguarda o formulário real, em vez de depender de um atraso fixo.
    await page
      .locator('input[type="password"]')
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    await logPage(page, "Credentials Form");
    await saveScreenshot(page, "login-credentials-form");

    // Diagnóstico: loga todos os inputs encontrados
    const allInputs = await page.locator("input").all();
    console.log(`[LOGIN] Total inputs encontrados: ${allInputs.length}`);
    for (let i = 0; i < allInputs.length; i++) {
      const type = await allInputs[i].getAttribute("type").catch(() => "?");
      const name = await allInputs[i].getAttribute("name").catch(() => "?");
      const id = await allInputs[i].getAttribute("id").catch(() => "?");
      const placeholder = await allInputs[i]
        .getAttribute("placeholder")
        .catch(() => "?");
      const formcontrol = await allInputs[i]
        .getAttribute("formcontrolname")
        .catch(() => "?");
      console.log(
        `[LOGIN] input[${i}] type=${type} id=${id} name=${name} placeholder=${placeholder} formcontrolname=${formcontrol}`,
      );
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
        const el = await firstVisible([page.locator(sel)], { enabled: true });
        if (el) {
          userInput = el;
          console.log(`[LOGIN] Campo usuário encontrado com seletor: ${sel}`);
          break;
        }
      } catch (_) {}
    }

    if (!userInput) {
      const shot = await saveScreenshot(page, "login-field-not-found");
      throw new Error(
        `LOGIN_USER_FIELD_NOT_FOUND | screenshot=${shot} | Veja os logs [LOGIN] input[N] para identificar o seletor correto`,
      );
    }

    await userInput.scrollIntoViewIfNeeded().catch(() => {});
    await userInput.click({ timeout: 5000 });
    await userInput.fill(user);
    await sleep(500);

    // Senha
    const passInput = await firstVisible(
      [page.locator('input[type="password"]')],
      { enabled: true },
    );
    if (!passInput) throw new Error("LOGIN_PASSWORD_FIELD_NOT_FOUND");
    await passInput.waitFor({ state: "visible", timeout: 10000 });
    await passInput.click();
    await passInput.fill(pass);
    await passInput.press("Tab");
    if (
      (await userInput.inputValue()) !== user ||
      (await passInput.inputValue()) !== pass
    ) {
      throw new Error(
        "LOGIN_FIELDS_NOT_FILLED | O formulário não manteve os campos preenchidos",
      );
    }
    console.log(
      "[LOGIN] Campos preenchidos e confirmados; procurando envio do formulário",
    );

    // Botão Entrar
    const credentialsForm = passInput.locator("xpath=ancestor::form[1]");
    const submitCandidates = [
      credentialsForm.getByRole("button", {
        name: /^(entrar|login|log\s*in|sign\s*in|acessar|continue|continuar)$/i,
      }),
      credentialsForm.locator('button[type="submit"], input[type="submit"]'),
      page.getByRole("button", {
        name: /^(entrar|login|log\s*in|sign\s*in|acessar|continue|continuar)$/i,
      }),
      // Seletor confirmado na tela atual do WMS.
      page
        .locator(
          "#root > span > main > div.sc-iplGWa.dSbpxF > div.sc-hVclCJ.lioTXk > div:nth-child(2) > div.sc-iXVhFP.iaeXyS.btn.btn-primary > button.sc-fujBio.cHqVJM.primary",
        )
        .first(),
      page.getByRole("link", {
        name: /^(entrar|login|log\s*in|sign\s*in|acessar|continue|continuar)$/i,
      }),
      page.locator('button:has-text("Entrar")').first(),
      page.locator('button:has-text("Sign in")').first(),
      page.locator('button[type="submit"]').first(),
      page.locator('input[type="submit"]').first(),
      // Algumas versões do WMS renderizam o submit sem texto acessível.
      credentialsForm
        .locator('button[type="submit"], input[type="submit"], [role="button"]')
        .last(),
      credentialsForm
        .locator('button, input[type="submit"], [role="button"]')
        .last(),
    ];
    let clicked = false;
    for (const btn of submitCandidates) {
      try {
        const target = await firstVisible([btn], { enabled: true });
        if (target) {
          await target.click({ timeout: 8000 });
          clicked = true;
          console.log("[LOGIN] Botão Entrar clicado");
          break;
        }
      } catch (error) {
        console.log("[LOGIN] Candidato de envio falhou:", error.name);
      }
    }
    // Último fallback: o formulário HTML deve submeter ao pressionar Enter no campo de senha.
    if (!clicked) {
      console.warn(
        "[LOGIN] Botão de envio não identificado; tentando Enter no campo de senha",
      );
      await passInput.press("Enter", { timeout: 8000 });
    }

    // Aguarda o redirect ou o desaparecimento do formulário. Sem esta validação
    // o bot salvava uma sessão inválida e só falhava depois, em NAV_FAILED.
    let outcome;
    try {
      outcome = await waitForLogin(page);
    } catch (error) {
      if (error.name !== "TimeoutError") throw error;
      const shot = await saveScreenshot(page, "login-failed");
      throw new Error(
        `LOGIN_FAILED | O login não foi confirmado em 60s; confira a mensagem do formulário | screenshot=${shot}`,
      );
    }
    if (outcome.status === "error") {
      const shot = await saveScreenshot(page, "login-failed");
      const message = outcome.message
        .split(pass)
        .join("[senha]")
        .split(user)
        .join("[usuario]");
      throw new Error(`LOGIN_REJECTED | ${message} | screenshot=${shot}`);
    }

    await logPage(page, "After Login");
    await saveScreenshot(page, "after-login");
    if (await isLoginPage(page)) {
      const shot = await saveScreenshot(page, "login-failed");
      throw new Error(
        `LOGIN_FAILED | O WMS permaneceu na tela de login | screenshot=${shot}`,
      );
    }
    return page.url();
  }

  async function isLoginPage(page) {
    const url = page.url().toLowerCase();
    if (url.includes("multiple-realms") || url.includes("/login")) return true;

    const passwordVisible = await page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    if (passwordVisible) return true;

    const realmTextVisible = await page
      .getByText(/login\s+(with\s+)?credentials|login\s+com\s+credenciais/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);
    return realmTextVisible;
  }

  async function isLoggedIn(page) {
    if (await isLoginPage(page)) return false;
    // Verifica se há elemento característico da sessão autenticada
    const nav = await firstVisible([
      page.locator('nav, .sidebar, [class*="menu"], [class*="nav"]'),
    ]);
    return !!nav;
  }

  // ── Fecha modal de NPS se aparecer ─────────────────────────
  async function dismissNpsModal(page) {
    try {
      // Verifica se o modal ambevtech-nps está presente
      const npsDiv = page.locator("#ambevtech-nps");
      const npsVisible = await npsDiv
        .isVisible({ timeout: 2000 })
        .catch(() => false);
      if (!npsVisible) return false;

      console.log("[NPS] Modal NPS detectado — tentando fechar...");

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
        npsDiv.locator("button.close").first(),
        npsDiv.locator('button[class*="close"]').first(),
        npsDiv.locator('button[class*="dismiss"]').first(),
        npsDiv.locator('button[class*="later"]').first(),
        // Fallback global
        page.locator('button:has-text("Ask me later")').first(),
        page.locator("#ambevtech-nps button").last(),
      ];

      for (const btn of candidates) {
        try {
          if ((await btn.count()) && (await btn.isVisible({ timeout: 1000 }))) {
            await btn.click({ timeout: 3000 });
            console.log("[NPS] Modal NPS fechado via botão");
            await sleep(1200);
            return true;
          }
        } catch (_) {}
      }

      // Último recurso: pressiona Escape
      await page.keyboard.press("Escape");
      await sleep(800);
      const aindaVisivel = await npsDiv
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (!aindaVisivel) {
        console.log("[NPS] Modal NPS fechado via Escape");
        return true;
      }

      // Força remoção via JS se tudo falhar
      await page.evaluate(() => {
        const el = document.getElementById("ambevtech-nps");
        if (el) el.remove();
      });
      console.log("[NPS] Modal NPS removido via JS");
      await sleep(500);
      return true;
    } catch (e) {
      console.log("[NPS] Erro ao fechar NPS:", e.message.slice(0, 80));
      return false;
    }
  }

  // Garante que o modal NPS não existe antes de qualquer clique importante
  async function ensureNoNpsModal(page) {
    let tentativas = 0;
    while (tentativas < 3) {
      const npsVisible = await page
        .locator("#ambevtech-nps")
        .isVisible({ timeout: 1000 })
        .catch(() => false);
      if (!npsVisible) break;
      console.log(
        `[NPS] Modal ainda visível — tentativa ${tentativas + 1} de fechar`,
      );
      await dismissNpsModal(page);
      tentativas++;
    }
  }

  // ── Navegação para Detalhes da Separação ────────────────────
  async function navegarSeparacao(page) {
    console.log("[NAV] Iniciando navegação para Detalhes da Separação...");
    await saveScreenshot(page, "nav-inicio");

    // ── Estratégia 1: URLs diretas com hash (tenta variações) ──
    console.log("[NAV] Tentando URLs diretas...");
    for (const altUrl of URL_SEPARACAO_ALTS) {
      try {
        console.log("[NAV] Tentando:", altUrl);
        await page.goto(altUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForLoadState("networkidle").catch(() => {});
        await sleep(2500);
        await logPage(page, "Nav URL direta");
        if (await onDetalhesPage(page)) {
          console.log("[NAV] Chegou via URL direta:", altUrl);
          return true;
        }
      } catch (e) {
        console.log("[NAV] URL falhou:", e.message.slice(0, 60));
      }
    }

    // Fecha modal NPS antes de tentar o menu
    await dismissNpsModal(page);

    // ── Estratégia 2: Menu lateral ──
    // O menu tem item pai "Separação" (com ícone de expandir) e submenu "Detalhes da Separação"
    // O item pai precisa ser clicado para expandir — mas o locator 'text=Separação' resolve
    // para itens de submenu ocultos. Precisamos clicar no item PAI do menu principal.
    console.log("[NAV] Tentando pelo menu lateral...");

    // Clica no item pai "Separação" no menu principal (não nos submenus ocultos)
    // Seletores específicos para menu pai — evita pegar submenus ocultos
    const menuPaiCandidates = [
      // Elemento de menu principal com label exata "Separação" (sem espaços extras)
      page.locator('.menu-item-label:text-is("Separação")').first(),
      page.locator('.nav-item-label:text-is("Separação")').first(),
      page
        .locator("li")
        .filter({ has: page.locator(':text-is("Separação")') })
        .first(),
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
        const visible = await candidato
          .isVisible({ timeout: 2000 })
          .catch(() => false);
        if (!visible) continue;

        await candidato.scrollIntoViewIfNeeded().catch(() => {});
        await candidato.click({ timeout: 5000 });
        console.log('[NAV] Menu pai "Separação" clicado');
        await sleep(1500);
        menuExpandido = true;
        break;
      } catch (e) {
        console.log("[NAV] Candidato menu pai falhou:", e.message.slice(0, 80));
      }
    }

    if (!menuExpandido) {
      console.warn(
        "[NAV] Não conseguiu expandir menu pai, tentando submenu diretamente...",
      );
    }

    await saveScreenshot(page, "nav-menu-expandido");

    // Agora clica em "Detalhes da Separação" no submenu (deve estar visível após expandir)
    const subMenuCandidates = [
      page
        .locator('.sub-menu-item-label:has-text("Detalhes da Separação")')
        .first(),
      page
        .locator('span.sub-menu-item-label:has-text("Detalhes da Separação")')
        .first(),
      page.locator('a:has-text("Detalhes da Separação")').first(),
      page.locator('li:has-text("Detalhes da Separação")').first(),
      page.locator(':text-is("Detalhes da Separação")').first(),
    ];

    for (const candidato of subMenuCandidates) {
      try {
        const count = await candidato.count();
        if (!count) continue;

        // Aguarda ficar visível (submenu pode ter animação de abertura)
        await candidato.waitFor({ state: "visible", timeout: 5000 });
        await candidato.scrollIntoViewIfNeeded().catch(() => {});
        await candidato.click({ timeout: 8000 });
        console.log('[NAV] Submenu "Detalhes da Separação" clicado');
        await sleep(3000);

        if (await onDetalhesPage(page)) {
          console.log("[NAV] Navegação via menu concluída com sucesso");
          return true;
        }
      } catch (e) {
        console.log("[NAV] Candidato submenu falhou:", e.message.slice(0, 80));
      }
    }

    await saveScreenshot(page, "nav-falhou");
    await logPage(page, "Nav falhou");
    return false;
  }

  async function onDetalhesPage(page) {
    try {
      const url = page.url();
      // Verifica URL
      if (
        url.includes("separation-details") ||
        url.includes("separacao-detalhes")
      )
        return true;
      // Verifica título da página
      const heading = await page
        .locator("h1, h2, .page-title, .content-title")
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => "");
      if (heading.toLowerCase().includes("detalhes")) return true;
      // Verifica breadcrumb
      const breadcrumb = await page
        .locator("text=Detalhes da Separação")
        .count()
        .catch(() => 0);
      return breadcrumb > 0;
    } catch {
      return false;
    }
  }

  // ── Preenchimento de filtros e download ─────────────────────
  async function setDateFilter(page, dateBr) {
    await ensureNoNpsModal(page);
    const { applyDateFilter } = require("./date-filter.cjs");
    return applyDateFilter(page, dateBr);
  }

  // Remove qualquer overlay/modal que possa interceptar cliques
  async function forceRemoveOverlays(page) {
    await page
      .evaluate(() => {
        // Remove NPS ambevtech
        ["#ambevtech-nps", "ambevtech-nps", '[id*="nps"]'].forEach((sel) => {
          document.querySelectorAll(sel).forEach((el) => el.remove());
        });
        // Remove overlays/backdrops genéricos
        document
          .querySelectorAll(
            '.modal-backdrop, .overlay, [class*="backdrop"], [class*="overlay"]',
          )
          .forEach((el) => {
            el.style.pointerEvents = "none";
            el.style.display = "none";
          });
      })
      .catch(() => {});
  }

  async function clickDownloadBtn(page, fileDate) {
    const { clickDownload } = require("../download");
    return clickDownload(page, fileDate, {
      downloadDir: DOWNLOAD_DIR,
      removeOverlays: forceRemoveOverlays,
      timeout: config.downloadTimeoutMs,
    });
  }

  async function runFlow(options = {}) {
    const requestedDate = options.date;
    const dateBr = formatDateBR(requestedDate);
    const fileDate = normalizeFileDate(requestedDate);

    ensureDir(DOWNLOAD_DIR);

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const abort = () => {
      void browser.close().catch(() => {});
    };
    signal?.addEventListener("abort", abort, { once: true });
    const storageState = getStorageStateIfExists();
    let context, page;
    try {
      if (signal?.aborted)
        throw new Error("Execução interrompida pelo encerramento do serviço");
      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 },
        ...(storageState ? { storageState } : {}),
      });

      page = await context.newPage();
      // Tenta navegar direto para a tela de separação com sessão salva
      if (storageState) {
        await page.goto(URL_SEPARACAO, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForLoadState("networkidle").catch(() => {});
        await sleep(2000);
      }

      // Verifica se está logado; se não, faz login
      const loggedIn = await isLoggedIn(page);
      if (!loggedIn) {
        if (!WMS_USER || !WMS_PASS) {
          throw new Error(
            "AUTH_REQUIRED | Configure WMS_USER e WMS_PASS nas variáveis de ambiente",
          );
        }
        await doLogin(page, WMS_USER, WMS_PASS);

        // Salva sessão após login bem-sucedido
        ensureDir(path.dirname(SESSION_FILE));
        const state = await context.storageState();
        fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
        console.log("[SESSION] StorageState salvo após login");
      }

      // Fecha modal de NPS se aparecer (surge após login ou ao navegar)
      await dismissNpsModal(page);

      // Navega para Detalhes da Separação
      const onPage = await navegarSeparacao(page);
      if (!onPage) {
        const shot = await saveScreenshot(page, "nav-failed");
        throw new Error(
          `NAV_FAILED | Não foi possível chegar em Detalhes da Separação | screenshot=${shot}`,
        );
      }

      await saveScreenshot(page, "before-filter");

      // Aplica filtro de data e consulta
      const filtered = await setDateFilter(page, dateBr);
      if (!filtered) {
        throw new Error("FILTER_NOT_CONFIRMED | O período não foi confirmado");
      }

      await saveScreenshot(page, "after-filter");

      // Clica no botão de download
      const result = await clickDownloadBtn(page, fileDate);
      if (!result) {
        const shot = await saveScreenshot(page, "download-failed");
        throw new Error(
          `DOWNLOAD_FAILED | Nenhum download concluído; verifique os candidatos e erros no log | screenshot=${shot}`,
        );
      }

      const successShot = await saveScreenshot(page, "success");
      // Envio para o backend se configurado
      // O worker faz validação e upload depois de persistir o arquivo.

      return {
        success: true,
        file: result.filePath,
        suggestedFilename: result.suggestedFilename,
        dateUsed: dateBr,
        screenshot: successShot,
      };
    } catch (error) {
      if (page) await saveScreenshot(page, "failed");
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (context) await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  return runFlow({ date });
};
