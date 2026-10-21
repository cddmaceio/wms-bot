import { Settings } from "./types";
import { Store } from "./store";
import { localTime } from "./time";

export function matches(settings: Settings, at: Date) {
  const time = localTime(at, settings.timezone);
  return (
    settings.weekdays.includes(time.weekday) &&
    settings.times.includes(time.time)
  );
}
export function nextSlots(settings: Settings, now = new Date()) {
  if (!settings.scheduleEnabled) return [];
  const slots: string[] = [];
  for (
    let t = Math.floor(now.getTime() / 60000) * 60000 + 60000;
    t < now.getTime() + 8 * 86400000 && slots.length < 5;
    t += 60000
  ) {
    if (matches(settings, new Date(t))) slots.push(new Date(t).toISOString());
  }
  return slots;
}
export class Scheduler {
  constructor(
    private store: Store,
    private getSettings: () => Settings,
    private create: (date: string, key: string) => string,
    now = new Date(),
  ) {
    const previous = store.meta("scheduler_checkpoint");
    const minute = Math.floor(now.getTime() / 60000) * 60000;
    if (previous)
      this.recordMissed(Number(previous), minute, this.getSettings());
    const settings = this.getSettings();
    if (settings.scheduleEnabled && matches(settings, new Date(minute)))
      store.slot(this.key(new Date(minute), settings), "missed");
    store.setMeta("scheduler_checkpoint", String(minute));
  }
  private key(at: Date, settings: Settings) {
    const t = localTime(at, settings.timezone);
    return `${settings.timezone}:${t.date}:${t.time}`;
  }
  private recordMissed(previous: number, current: number, s: Settings) {
    if (!s.scheduleEnabled || !Number.isFinite(previous)) return;
    if (current - previous > 8 * 86400000)
      this.store.audit("schedule_gap", {
        from: new Date(previous).toISOString(),
        until: new Date(current).toISOString(),
      });
    for (
      let t = Math.max(previous + 60000, current - 8 * 86400000);
      t < current;
      t += 60000
    )
      if (matches(s, new Date(t)))
        this.store.slot(this.key(new Date(t), s), "missed");
  }
  tick(now = new Date()) {
    const minute = Math.floor(now.getTime() / 60000) * 60000;
    const previous = Number(this.store.meta("scheduler_checkpoint"));
    if (minute <= previous) return;
    const s = this.getSettings();
    this.store.transaction(() => {
      this.recordMissed(previous, minute, s);
      if (s.scheduleEnabled && matches(s, new Date(minute))) {
        const key = this.key(new Date(minute), s);
        const date = localTime(new Date(minute), s.timezone).date;
        // Apenas o minuto corrente é elegível; slots antigos ficam visíveis como perdidos.
        const id = this.create(date, `schedule:${key}`);
        this.store.slot(key, "queued", id);
      }
      this.store.setMeta("scheduler_checkpoint", String(minute));
    });
  }
}
