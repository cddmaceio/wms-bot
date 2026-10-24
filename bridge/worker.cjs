require("./patch-wwebjs.cjs").applyPatch();
const { Client, LocalAuth } = require("whatsapp-web.js");
const QRCode = require("qrcode");
const { chromium } = require("playwright");
const path = require("node:path");
const { sendText } = require("./text.cjs");
const { inspectSession } = require("./health.cjs");
const { acquireProfileLease, profileInUse } = require('./profile.cjs');
let client,
  qr,
  state = "disabled",
  lastError = null,
  enabled = process.env.WHATSAPP_ENABLED === "true",
  connecting = false;
let sending = false;
let profileLease, shuttingDown = false;
const data = process.env.DATA_DIR;
function fail(next, error) {
  state = next;
  qr = null;
  lastError = String(error?.message || error || next)
    .replace(/\d{8,}/g, "[numero]")
    .slice(0, 500);
  process.send?.({ event: next });
}
async function connect(force = false) {
  if (
    !enabled || shuttingDown ||
    connecting ||
    ["initializing", "authenticated", "qr"].includes(state) ||
    (!force && state === "ready")
  )
    return;
  if (sending) throw new Error("Aguarde a tentativa de envio terminar antes de reconectar");
  connecting = true;
  state = "initializing";
  lastError = null;
  qr = null;
  const previous = client;
  client = null;
  healthCheck = undefined;
  try {
    if (previous) await previous.destroy().catch(() => {});
    if (!profileLease) profileLease = await acquireProfileLease(data);
    const recovered = profileLease.recover();
    if (recovered.length) process.send?.({event:'profile_lock_recovered'});
    lastError = null;
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: "wms-bot",
        dataPath: path.join(data, "whatsapp"),
      }),
      webVersionCache: {
        type: "local",
        path: path.join(data, "whatsapp-cache"),
      },
      puppeteer: {
        executablePath: chromium.executablePath(),
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },
      deviceName: "WMS Bot",
    });
    const active = client;
    active.on("qr", (value) => {
      QRCode.toDataURL(value)
        .then((image) => {
          if (client === active && enabled) {
            qr = image;
            state = "qr";
            lastError = null;
          }
        })
        .catch((error) => fail("qr_error", error));
    });
    active.on("authenticated", () => {
      if (client === active) {
        state = "authenticated";
        qr = null;
      }
    });
    active.on("ready", async () => {
      if (client !== active) return;
      try {
        const health = await inspectSession(active);
        if (!health.ready) throw new Error(health.reason);
        if (client === active && enabled) {
          state = "ready";
          qr = null;
          lastError = null;
        }
      } catch (error) {
        if (client === active) fail("compatibility_error", error);
      }
    });
    active.on("auth_failure", (error) => {
      if (client === active) fail("auth_failure", error);
    });
    active.on("disconnected", (error) => {
      if (client === active) fail("disconnected", error);
    });
    const deadline = setTimeout(() => {
      if (
        client === active &&
        ["initializing", "authenticated"].includes(state)
      )
        fail(
          "initialization_failed",
          new Error(
            "Inicialização excedeu 90 segundos; tente conectar novamente",
          ),
        );
    }, 90000);
    active
      .initialize()
      .catch((error) => {
        if (client === active) fail("initialization_failed", error);
      })
      .finally(() => clearTimeout(deadline));
  } catch (error) {
    fail("initialization_failed", error);
  } finally {
    connecting = false;
  }
}
let healthCheck;
async function status() {
  const active = client;
  let health = null;
  if (enabled && active && ['ready', 'session_unavailable'].includes(state)) {
    if (!healthCheck) {
      const check = inspectSession(active).then(result => {
        if (client === active && enabled && ['ready', 'session_unavailable'].includes(state)) {
          if (!result.ready && state === 'ready') fail('session_unavailable', result.reason);
          else if (result.ready && state === 'session_unavailable') {
            state = 'ready'; lastError = null;
          }
        }
        return result;
      }).finally(() => { if (healthCheck === check) healthCheck = undefined; });
      healthCheck = check;
    }
    health = await healthCheck;
  }
  return { state, ready: state === 'ready' && health?.ready === true, lastError, health };
}
async function handle(action, payload) {
  if (action === "status") return status();
  if (action === "qr") return { state, image: state === "qr" ? qr : null };
  if (action === "configure") {
    enabled = payload.enabled === true;
    if (!enabled) {
      const old = client;
      client = null;
      qr = null;
      state = "disabled";
      if (old) await old.destroy().catch(() => {});
    } else await connect();
    return {};
  }
  if (action === "connect") {
    await connect(true);
    return {};
  }
  if (action === "send") {
    if (!enabled || sending || state !== "ready")
      return {
        state: "not_sent",
        note: "WhatsApp indisponível antes da tentativa",
      };
    sending = true;
    try {
      if (!(await status()).ready)
        return { state: 'not_sent', note: 'Sessão WhatsApp indisponível antes do envio' };
      return await sendText(client, payload.recipient, payload.text);
    } finally {
      sending = false;
    }
  }
  throw new Error("Ação desconhecida");
}
process.on("message", async (message) => {
  try {
    process.send?.({
      id: message.id,
      value: await handle(message.action, message.payload || {}),
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: String(error.message)
        .replace(/\d{8,}/g, "[numero]")
        .slice(0, 500),
    });
  }
});
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; enabled = false;
  const active = client; client = null;
  let timer;
  try {
    await Promise.race([
      active ? active.destroy().catch(() => {}) : Promise.resolve(),
      new Promise(resolve => { timer = setTimeout(resolve, 8000); }),
    ]);
    if (profileLease && (process.platform !== 'linux' || !profileInUse(profileLease.profile))) await profileLease.release();
  } finally {
    clearTimeout(timer);
    process.exit(0);
  }
}
process.on('disconnect', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
if (enabled) connect();
