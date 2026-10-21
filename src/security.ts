import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { AppError } from "./types";

export class Vault {
  private key: Buffer;
  constructor(key: string) {
    this.key = Buffer.from(key, "hex");
    if (!/^[a-f0-9]{64}$/i.test(key) || this.key.length !== 32)
      throw new Error("SETTINGS_KEY deve conter 64 caracteres hexadecimais");
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), body]
      .map((b) => b.toString("base64"))
      .join(".");
  }
  open<T>(value: string): T {
    const [iv, tag, body] = value
      .split(".")
      .map((s) => Buffer.from(s, "base64"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(
      Buffer.concat([cipher.update(body), cipher.final()]).toString("utf8"),
    );
  }
}
export function authorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function redact(value: unknown, secrets: string[] = []): string {
  let text = String(value instanceof Error ? value.message : value);
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[segredo]");
  return text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [segredo]").slice(0, 2000);
}
export function requireConfirmation(
  value: unknown,
  message = "Confirme a operação",
): void {
  if (value !== true) throw new AppError(message);
}
