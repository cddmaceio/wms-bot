const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Scheduler, nextSlots } = require("../dist/scheduler");
const { setup } = require("./helpers.cjs");
test("Agenda usa fuso, vários horários e não duplica o mesmo disparo", (t) => {
  const { store, settings } = setup(t, {
    scheduleEnabled: true,
    times: ["06:00", "12:00"],
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  let count = 0;
  const scheduler = new Scheduler(
    store,
    () => settings.get(),
    () => `job-${++count}`,
    new Date("2026-10-20T08:59:00Z"),
  );
  scheduler.tick(new Date("2026-10-20T09:00:00Z"));
  scheduler.tick(new Date("2026-10-20T09:00:30Z"));
  assert.equal(count, 1);
  assert.equal(store.slots()[0].state, "queued");
  assert.equal(
    nextSlots(settings.get(), new Date("2026-10-20T09:01:00Z"))[0],
    "2026-10-20T15:00:00.000Z",
  );
});
test("Reinício registra horários perdidos sem disparar consultas retroativas", (t) => {
  const { store, settings } = setup(t, {
    scheduleEnabled: true,
    times: ["06:00"],
    weekdays: [0, 1, 2, 3, 4, 5, 6],
  });
  store.setMeta(
    "scheduler_checkpoint",
    String(Date.parse("2026-10-20T08:59:00Z")),
  );
  let calls = 0;
  const scheduler = new Scheduler(
    store,
    () => settings.get(),
    () => {
      calls++;
      return "job";
    },
    new Date("2026-10-20T09:05:00Z"),
  );
  assert.equal(store.slots()[0].state, "missed");
  scheduler.tick(new Date("2026-10-20T09:06:00Z"));
  assert.equal(calls, 0);
});
