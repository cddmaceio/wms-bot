"use strict";
const $ = (id) => document.getElementById(id);
let token = "",
  settings,
  selectedJob = null,
  refreshing = false;
const names = {
  queued: "Na fila",
  downloading: "Baixando",
  validating: "Validando",
  uploading: "Importando",
  completed: "Concluído",
  partial: "Com pendências",
  failed: "Falha",
  uncertain: "Conferir resultado",
  no_data: "Sem dados",
  downloaded: "Baixado sem API",
  pending: "Pendente",
  sending: "Enviando",
  confirmed: "Confirmado",
  skipped: "Ignorado",
  blocked: "Bloqueado",
  missed: "Horário perdido",
  ready: "Conectado",
  disabled: "Desativado",
  unavailable: "Indisponível",
  qr: "Aguardando QR",
  initializing: "Conectando",
  authenticated: "Autenticado",
  disconnected: "Desconectado",
  auth_failure: "Falha de autenticação",
  initialization_failed: "Falha ao conectar",
  compatibility_error: "Requer atualização de compatibilidade",
};
const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const badge = (state) => el("span", names[state] || state, `badge ${state}`);
const date = (value) =>
  value
    ? new Date(value).toLocaleString("pt-BR", {
        timeZone: settings?.timezone || "America/Maceio",
      })
    : "—";
function notice(text, error = false) {
  $("notice").textContent = text;
  $("notice").className = error ? "error" : "";
  $("notice").hidden = false;
}
async function api(url, options = {}) {
  const response = await fetch("/api" + url, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401) {
    logout();
    throw new Error("Token inválido ou sessão encerrada.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "Falha ao consultar a aplicação.");
  }
  return response.json();
}
function action(fn) {
  return async (event) => {
    const button =
      event?.submitter ||
      (event?.currentTarget?.tagName === "BUTTON" ? event.currentTarget : null);
    if (button) button.disabled = true;
    try {
      await fn(event);
    } catch (error) {
      notice(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
function button(text, fn, className = "secondary") {
  const node = el("button", text, className);
  node.type = "button";
  node.addEventListener("click", action(fn));
  return node;
}
function show(tab) {
  document
    .querySelectorAll("[data-view]")
    .forEach((node) => (node.hidden = node.dataset.view !== tab));
  document.querySelectorAll("[data-tab]").forEach((node) => {
    const active = node.dataset.tab === tab;
    node.classList.toggle("active", active);
    if (active) {
      node.setAttribute("aria-current", "page");
      $("page-title").textContent = node.querySelector("span").textContent;
    } else node.removeAttribute("aria-current");
  });
}
document
  .querySelectorAll("[data-tab]")
  .forEach((node) =>
    node.addEventListener("click", () => show(node.dataset.tab)),
  );
function logout() {
  token = "";
  $("token").value = "";
  $("workspace").hidden = true;
  $("login").hidden = false;
  $("logout").hidden = true;
  $("refresh").disabled = true;
  $("qr").removeAttribute("src");
  $("qr").hidden = true;
  settings = null;
  selectedJob = null;
}
$("logout").addEventListener("click", logout);
$("login-form").addEventListener(
  "submit",
  action(async (event) => {
    event.preventDefault();
    token = $("token").value;
    settings = await api("/settings");
    $("token").value = "";
    fillSettings();
    $("login").hidden = true;
    $("workspace").hidden = false;
    $("logout").hidden = false;
    $("refresh").disabled = false;
    $("notice").hidden = true;
    await refresh();
  }),
);
$("go-run").addEventListener("click", () => show("jobs"));
$("refresh").addEventListener(
  "click",
  action(() => refresh()),
);
$("close-detail").addEventListener("click", () => {
  selectedJob = null;
  $("job-detail").hidden = true;
});
function fillSettings() {
  document.querySelectorAll("[data-setting]").forEach((input) => {
    const key = input.dataset.setting;
    if (input.type === "password") {
      input.value = "";
      const note = document.querySelector(`[data-secret="${key}"]`);
      if (note)
        note.textContent = settings[key + "Configured"]
          ? "Já configurado. Preencha somente para substituir."
          : "Não configurado.";
    } else if (input.type === "checkbox") input.checked = settings[key];
    else input.value = settings[key];
  });
  $("schedule-times").value = settings.times.join(", ");
  $("recipients").value = settings.recipients.join("\n");
  document
    .querySelectorAll("#weekdays input")
    .forEach(
      (input) =>
        (input.checked = settings.weekdays.includes(Number(input.value))),
    );
  document
    .querySelectorAll("#events input")
    .forEach(
      (input) => (input.checked = settings.events.includes(input.value)),
    );
  $("clear-api-token").checked = false;
  $("test-recipient").replaceChildren(
    ...settings.recipients.map((r) => {
      const option = el("option", r);
      option.value = r;
      return option;
    }),
  );
}
for (const id of ["settings-form", "schedule-form", "whatsapp-form"])
  $(id).addEventListener(
    "submit",
    action(async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        patch = {};
      form.querySelectorAll("[data-setting]").forEach((input) => {
        if (input.type === "password" && !input.value) return;
        patch[input.dataset.setting] =
          input.type === "checkbox"
            ? input.checked
            : input.type === "number"
              ? Number(input.value)
              : input.type === "password"
                ? input.value
                : input.value.trim();
      });
      if (id === "settings-form" && $("clear-api-token").checked)
        patch.apiToken = "";
      if (id === "schedule-form") {
        patch.times = $("schedule-times")
          .value.split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        patch.weekdays = [
          ...document.querySelectorAll("#weekdays input:checked"),
        ].map((i) => Number(i.value));
      }
      if (id === "whatsapp-form") {
        patch.recipients = $("recipients")
          .value.split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean);
        patch.events = [
          ...document.querySelectorAll("#events input:checked"),
        ].map((i) => i.value);
      }
      settings = await api("/settings", {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      fillSettings();
      notice("Configurações salvas.");
      await refresh();
    }),
  );
$("run-form").addEventListener(
  "submit",
  action(async (event) => {
    event.preventDefault();
    const input = { requestKey: crypto.randomUUID() };
    if ($("run-date").value) input.date = $("run-date").value;
    const job = await api("/jobs", {
      method: "POST",
      body: JSON.stringify(input),
    });
    selectedJob = job.id;
    notice("Consulta adicionada à fila.");
    await refresh();
  }),
);
$("connect").addEventListener(
  "click",
  action(async () => {
    await api("/whatsapp/connect", { method: "POST" });
    await refresh();
    notice(
      "Conexão solicitada. O QR será atualizado automaticamente quando disponível.",
    );
  }),
);
$("test-form").addEventListener(
  "submit",
  action(async (event) => {
    event.preventDefault();
    const recipient = $("test-recipient").value;
    if (!confirm(`Enviar uma mensagem de teste para ${recipient}?`)) return;
    await api("/whatsapp/test", {
      method: "POST",
      body: JSON.stringify({
        recipient,
        confirmed: true,
        requestKey: crypto.randomUUID(),
      }),
    });
    notice("Mensagem de teste adicionada à fila.");
    await refresh();
  }),
);
async function artifact(id, kind) {
  const response = await fetch(`/api/jobs/${id}/artifacts/${kind}`, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!response.ok) {
    const body = await response.json();
    throw new Error(body.error);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = `wms-${id}.${kind === "csv" ? "csv" : "png"}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function renderJobs(jobs) {
  const rows = jobs.map((job) => {
    const row = el("tr");
    const first = el("td", job.date);
    first.append(el("small", job.id));
    row.append(
      first,
      el(
        "td",
        job.source.startsWith("upload:")
          ? "Reenvio API"
          : job.source === "schedule"
            ? "Agenda"
            : job.source === "notification-test"
              ? "Teste WhatsApp"
              : "Manual",
      ),
    );
    const state = el("td");
    state.append(badge(job.state));
    row.append(
      state,
      el("td", job.summary.processed ?? job.summary.records ?? "—"),
    );
    const view = el("td");
    view.append(
      button("Ver detalhes", async () => {
        selectedJob = job.id;
        await renderDetail();
        $("job-detail").scrollIntoView({ behavior: "smooth", block: "start" });
      }),
    );
    row.append(view);
    return row;
  });
  if (!rows.length) {
    const row = el("tr");
    const cell = el("td", "Nenhuma execução registrada.");
    cell.colSpan = 5;
    row.append(cell);
    rows.push(row);
  }
  $("jobs-table").replaceChildren(...rows);
  const latest = jobs.find((j) => j.source !== "notification-test");
  const area = $("latest");
  area.replaceChildren();
  if (!latest) {
    area.textContent = "Nenhuma execução registrada.";
    return;
  }
  area.append(
    badge(latest.state),
    el("p", `Consulta de ${latest.date} · ${date(latest.created)}`),
  );
  area.append(el("small", latest.id));
  if (latest.error) area.append(el("p", latest.error, "detail-error"));
}
async function renderDetail() {
  if (!selectedJob) return;
  const job = await api("/jobs/" + selectedJob);
  const content = $("detail-content");
  content.replaceChildren();
  $("job-detail").hidden = false;
  content.append(badge(job.state), el("p", job.id, "muted"));
  const grid = el("div", undefined, "detail-grid");
  for (const [label, value] of [
    ["Data consultada", job.date],
    ["Início", date(job.created)],
    ["Fim", date(job.finished)],
  ]) {
    const block = el("div", label, "muted");
    block.append(el("strong", value));
    grid.append(block);
  }
  content.append(grid);
  if (job.error) content.append(el("p", job.error, "detail-error"));
  const actions = el("div", undefined, "actions");
  if (job.file)
    actions.append(button("Baixar CSV", () => artifact(job.id, "csv")));
  if (job.screenshot)
    actions.append(
      button("Baixar screenshot", () => artifact(job.id, "screenshot")),
    );
  if (
    job.file &&
    ["completed", "partial", "failed", "uncertain", "downloaded"].includes(
      job.state,
    )
  )
    actions.append(
      button("Reenviar arquivo à API", async () => {
        if (
          !confirm(
            "Confira a importação no destino antes de repetir. Enviar este arquivo novamente usando a configuração atual da API?",
          )
        )
          return;
        const next = await api(`/jobs/${job.id}/retry-upload`, {
          method: "POST",
          body: JSON.stringify({
            confirmed: true,
            requestKey: crypto.randomUUID(),
          }),
        });
        selectedJob = next.id;
        notice("Reenvio da API adicionado à fila, sem nova consulta WMS.");
        await refresh();
      }),
    );
  content.append(actions);
  content.append(el("h3", "Resultado"));
  const results = el("div", undefined, "detail-grid");
  for (const [label, value] of [
    ["Registros no arquivo", job.summary.rawCount],
    ["Registros únicos", job.summary.records],
    ["Duplicatas removidas", job.summary.duplicates],
    ["Registros importados", job.summary.processed],
    ["Mapas atualizados", job.summary.maps],
  ]) {
    if (value === undefined) continue;
    const cell = el("div", label, "muted");
    cell.append(el("strong", value ?? "Não confirmado"));
    results.append(cell);
  }
  content.append(results);
  if (job.summary.errors?.length)
    for (const error of job.summary.errors)
      content.append(
        el(
          "p",
          typeof error === "string" ? error : JSON.stringify(error),
          "detail-error",
        ),
      );
  content.append(el("h3", "Etapas"));
  const stages = {
    download: "Download WMS",
    validation: "Validação do CSV",
    upload: "Envio à API",
    downloading: "Download WMS",
    validating: "Validação do CSV",
    uploading: "Envio à API",
    started: "Iniciado",
  };
  for (const attempt of job.attempts)
    content.append(
      el(
        "p",
        `${date(attempt.created)} · ${stages[attempt.stage] || attempt.stage} → ${names[attempt.state] || stages[attempt.state] || attempt.state}`,
        "muted",
      ),
    );
  content.append(el("h3", "Notificações"));
  if (!job.deliveries.length)
    content.append(
      el("p", "Nenhuma mensagem planejada para esta execução.", "muted"),
    );
  for (const item of job.deliveries) {
    const p = el("p", item.recipient + " · ");
    p.append(badge(item.state));
    if (item.waitingReason) p.append(el("small", item.waitingReason));
    if (item.note) p.append(el("small", item.note));
    content.append(p);
  }
}
function renderDeliveries(items) {
  const rows = items.map((item) => {
    const row = el("tr");
    row.append(el("td", item.recipient));
    const event = el("td", names[item.event] || item.event);
    event.append(el("small", item.jobId));
    row.append(event);
    const state = el("td");
    state.append(badge(item.state));
    if (item.waitingReason) state.append(el("small", item.waitingReason));
    if (item.note) state.append(el("small", item.note));
    row.append(state);
    const controls = el("td");
    if (["uncertain", "blocked", "pending"].includes(item.state)) {
      const actions =
        item.state === "pending"
          ? [["skip", "Cancelar"]]
          : [
              ["confirm", "Recebi"],
              ["retry", "Não recebi: tentar"],
              ["skip", "Ignorar"],
            ];
      for (const [act, label] of actions)
        controls.append(
          button(label, async () => {
            const note = prompt(
              `${label} — ${item.recipient}\nInforme a justificativa após conferir no aparelho:`,
            );
            if (!note) return;
            if (!confirm(`Confirmar ação "${label}" para ${item.recipient}?`))
              return;
            await api(`/deliveries/${item.id}/reconcile`, {
              method: "POST",
              body: JSON.stringify({ action: act, note, confirmed: true }),
            });
            notice("Conferência registrada.");
            await refresh();
          }),
        );
    }
    row.append(controls);
    return row;
  });
  if (!rows.length) {
    const row = el("tr");
    const cell = el("td", "Nenhuma mensagem registrada.");
    cell.colSpan = 4;
    row.append(cell);
    rows.push(row);
  }
  $("deliveries").replaceChildren(...rows);
}
async function refresh() {
  if (!token || refreshing) return;
  refreshing = true;
  try {
    const [status, jobs, deliveries, audits] = await Promise.all([
      api("/status"),
      api("/jobs"),
      api("/deliveries"),
      api("/audits"),
    ]);
    $("worker-state").textContent = status.workerHealthy
      ? "Operacional"
      : "Requer atenção";
    $("worker-note").textContent =
      status.workerError || "Consultas e importações disponíveis";
    $("wa-state").textContent =
      names[status.whatsapp.state] || status.whatsapp.state;
    $("wa-note").textContent =
      status.whatsapp.lastError || "Mensagens acompanhadas por confirmação";
    $("next-run").textContent = status.nextRuns.length
      ? date(status.nextRuns[0])
      : "Agenda desativada";
    $("timezone").textContent = "Fuso: " + settings.timezone;
    $("schedule-next").textContent = status.nextRuns.length
      ? "Próxima consulta: " + date(status.nextRuns[0])
      : "Agenda desativada";
    $("qr-state").textContent =
      names[status.whatsapp.state] || status.whatsapp.state;
    if (status.whatsapp.state === "qr") {
      const qr = await api("/whatsapp/qr");
      if (qr.image) {
        $("qr").src = qr.image;
        $("qr").hidden = false;
      }
    } else {
      $("qr").hidden = true;
      $("qr").removeAttribute("src");
    }
    $("updated").textContent =
      "Atualizado às " + new Date().toLocaleTimeString("pt-BR");
    $("slots").replaceChildren(
      ...status.slots.map((slot) => {
        const row = el("tr");
        row.append(el("td", slot.slot));
        const state = el("td");
        state.append(badge(slot.state));
        row.append(state);
        return row;
      }),
    );
    if (!status.slots.length) {
      const row = el("tr");
      const cell = el("td", "Nenhum horário registrado.");
      cell.colSpan = 2;
      row.append(cell);
      $("slots").append(row);
    }
    $("disk").textContent =
      `Espaço livre no volume: ${((status.disk.bavail * status.disk.bsize) / 1024 ** 3).toFixed(1)} GB`;
    $("diagnostic").textContent = JSON.stringify(
      {
        workerHealthy: status.workerHealthy,
        lastTick: status.lastTick,
        whatsapp: status.whatsapp,
        notifications: status.notifications,
      },
      null,
      2,
    );
    $("audits").replaceChildren(
      ...audits
        .slice(0, 20)
        .map((a) =>
          el(
            "div",
            `${date(a.created)} · ${a.action} · ${a.detail}`,
            "audit-row",
          ),
        ),
    );
    renderJobs(jobs);
    renderDeliveries(deliveries);
    await renderDetail();
  } finally {
    refreshing = false;
  }
}
setInterval(() => {
  if (token && !document.hidden)
    refresh().catch((error) => notice(error.message, true));
}, 10000);
