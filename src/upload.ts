import { Settings, UploadResult } from "./types";
import { redact } from "./security";
export async function uploadRecords(
  settings: Settings,
  records: Record<string, string>[],
  fileName: string,
  request: typeof fetch = fetch,
): Promise<UploadResult> {
  try {
    const response = await request(
      settings.apiUrl.replace(/\/$/, "") + settings.apiEndpoint,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...(settings.apiToken
            ? { Authorization: `Bearer ${settings.apiToken}` }
            : {}),
        },
        body: JSON.stringify({ records, file_name: fileName }),
        signal: AbortSignal.timeout(settings.uploadTimeoutMs),
      },
    );
    const text = await response.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error();
    } catch {
      return {
        state: "uncertain",
        status: response.status,
        processed: null,
        maps: null,
        errors: ["Resposta não JSON; conferir importação"],
        message: "Resposta inesperada da API",
      };
    }
    if (typeof body.success !== "boolean") {
      return {
        state: "uncertain",
        status: response.status,
        processed: null,
        maps: null,
        errors: ["Resposta sem confirmação de resultado; conferir importação"],
        message: "Estrutura de resposta inesperada da API",
      };
    }
    const errors = Array.isArray(body.errors)
      ? body.errors
      : body.errors
        ? [body.errors]
        : [];
    const processed =
      body.data?.processedCount ??
      body.total_processed ??
      body.inserted_count ??
      null;
    const maps =
      body.data?.conferenceMapsUpserted ?? body.maps_upserted ?? null;
    const complete =
      response.ok &&
      response.status !== 207 &&
      body.success === true &&
      errors.length === 0;
    const state = complete
      ? "completed"
      : response.status === 207 || errors.length || Number(processed) > 0
        ? "partial"
        : response.status >= 500
          ? "uncertain"
          : "failed";
    const clean = (value: unknown) =>
      redact(typeof value === "string" ? value : JSON.stringify(value), [
        settings.apiToken,
        settings.wmsPass,
      ]);
    return {
      state,
      status: response.status,
      processed,
      maps,
      errors: errors.map(clean),
      message: clean(body.message || body.error || `HTTP ${response.status}`),
    };
  } catch (error) {
    return {
      state: "uncertain",
      processed: null,
      maps: null,
      errors: [redact(error, [settings.apiToken, settings.wmsPass])],
      message: "Sem confirmação da API; conferir destino antes de repetir",
    };
  }
}
