import { Store } from "./store";
import { Vault } from "./security";
import { AppError, Settings } from "./types";

export const recipientPattern =
  /^(?:\d{10,15}@c\.us|\d{10,25}(?:-\d+)?@g\.us)$/;
const secretKeys = ["wmsPass", "apiToken"] as const;
export function defaults(env = process.env): Settings {
  return {
    wmsUrl: env.WMS_URL || "https://wmst2.ambev.com.br/wmsnew",
    wmsUser: env.WMS_USER || "",
    wmsPass: env.WMS_PASS || "",
    apiUrl: env.APP_API_URL || "",
    apiEndpoint: env.APP_API_ENDPOINT || "/api/conference/upload",
    apiToken: env.APP_API_TOKEN || "",
    timezone: env.APP_TIMEZONE || "America/Maceio",
    downloadTimeoutMs: Number(env.DOWNLOAD_TIMEOUT_MS || 60000),
    uploadTimeoutMs: 120000,
    retentionDays: 30,
    scheduleEnabled: false,
    times: ["06:00"],
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    whatsappEnabled: false,
    sendEnabled: false,
    recipients: [],
    events: [
      "completed",
      "partial",
      "failed",
      "uncertain",
      "no_data",
      "downloaded",
    ],
  };
}
function url(value: string, allowEmpty = false) {
  if (!value && allowEmpty) return;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("URL inválida");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new AppError("Use URL HTTP(S) sem credenciais, query ou fragmento");
}
export function validateSettings(s: Settings): Settings {
  for (const key of [
    "wmsUrl",
    "wmsUser",
    "wmsPass",
    "apiUrl",
    "apiEndpoint",
    "apiToken",
    "timezone",
  ] as const)
    if (typeof s[key] !== "string" || s[key].length > 2000)
      throw new AppError(`Configuração inválida: ${key}`);
  url(s.wmsUrl);
  url(s.apiUrl, true);
  if (
    !s.apiEndpoint.startsWith("/") ||
    s.apiEndpoint.startsWith("//") ||
    /[?#]/.test(s.apiEndpoint)
  )
    throw new AppError("Endpoint deve ser um caminho iniciado por /");
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: s.timezone });
  } catch {
    throw new AppError("Fuso horário inválido");
  }
  for (const key of [
    "scheduleEnabled",
    "whatsappEnabled",
    "sendEnabled",
  ] as const)
    if (typeof s[key] !== "boolean")
      throw new AppError(`${key} deve ser booleano`);
  for (const key of ["downloadTimeoutMs", "uploadTimeoutMs"] as const)
    if (!Number.isInteger(s[key]) || s[key] < 1000 || s[key] > 600000)
      throw new AppError("Timeout deve ficar entre 1000 e 600000 ms");
  if (
    !Number.isInteger(s.retentionDays) ||
    s.retentionDays < 1 ||
    s.retentionDays > 3650
  )
    throw new AppError("Retenção deve ficar entre 1 e 3650 dias");
  if (
    !Array.isArray(s.times) ||
    !s.times.length ||
    s.times.length > 24 ||
    s.times.some(
      (t) => typeof t !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t),
    )
  )
    throw new AppError("Informe de 1 a 24 horários HH:MM");
  if (
    !Array.isArray(s.weekdays) ||
    !s.weekdays.length ||
    s.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
  )
    throw new AppError("Dias devem usar domingo=0 até sábado=6");
  if (
    !Array.isArray(s.recipients) ||
    s.recipients.length > 100 ||
    s.recipients.some((r) => typeof r !== "string" || !recipientPattern.test(r))
  )
    throw new AppError("Destinatário inválido: use número@c.us ou ID@g.us");
  if (
    !Array.isArray(s.events) ||
    s.events.some(
      (e) =>
        ![
          "completed",
          "partial",
          "failed",
          "uncertain",
          "no_data",
          "downloaded",
        ].includes(e),
    )
  )
    throw new AppError("Evento de notificação inválido");
  return {
    ...s,
    times: [...new Set(s.times)].sort(),
    weekdays: [...new Set(s.weekdays)].sort(),
    recipients: [...new Set(s.recipients)],
  };
}
export class SettingsService {
  private value: Settings;
  constructor(
    private store: Store,
    readonly vault: Vault,
    initial = defaults(),
  ) {
    this.value = validateSettings(
      store.setting() ? vault.open<Settings>(store.setting()!) : initial,
    );
    if (!store.setting()) store.saveSetting(vault.seal(this.value));
  }
  get(): Settings {
    return structuredClone(this.value);
  }
  public() {
    const value: Record<string, unknown> = this.get() as unknown as Record<
      string,
      unknown
    >;
    for (const key of secretKeys) {
      value[`${key}Configured`] = !!value[key];
      delete value[key];
    }
    return value;
  }
  update(patch: Record<string, unknown>) {
    const current = this.get();
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new AppError("Objeto de configuração obrigatório");
    if (Object.keys(patch).some((key) => !Object.hasOwn(current, key)))
      throw new AppError("Configuração desconhecida");
    const next = validateSettings({ ...current, ...patch } as Settings);
    this.store.transaction(() => {
      this.store.saveSetting(this.vault.seal(next));
      this.store.audit("settings_updated", { fields: Object.keys(patch) });
    });
    this.value = next;
    return this.public();
  }
}
