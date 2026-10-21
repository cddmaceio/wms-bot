import { AppError } from "./types";
export function localTime(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (name: string) => parts.find((p) => p.type === name)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    date,
    time: `${get("hour")}:${get("minute")}`,
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
  };
}
export function validateDate(
  value: unknown,
  timezone: string,
  now = new Date(),
): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new AppError("Data deve usar AAAA-MM-DD");
  const parsed = new Date(`${value}T12:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    value > localTime(now, timezone).date
  )
    throw new AppError("Data inválida ou futura");
  return value;
}
