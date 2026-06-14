const state = {
  screen: "calendar",
  visibleMonth: "",
  selectedDate: "",
  data: null,
  admin: null
};

const appConfig = {
  choirName: "Choir Private Area",
  loginSubtitle: "Private area for choir members. Enter with your registered email."
};

const statusLabels = {
  coming: "Asistiré",
  late: "Llegaré tarde",
  absent: "No podré asistir"
};

const app = document.querySelector("#app");

boot();

async function boot() {
  try {
    await api("/api/me");
    state.data = await api("/api/data");
    if (state.data.user.role === "admin") state.admin = await api("/api/admin");
    initCalendarState();
    renderApp();
  } catch {
    renderLogin();
  }
}

function renderLogin(message = "") {
  app.innerHTML = `
    <main class="login">
      <section class="login-panel">
        ${brandLogo()}
        <h1>${escapeHtml(appConfig.choirName)}</h1>
        <p>${escapeHtml(appConfig.loginSubtitle)}</p>
        <form id="loginForm">
          <label class="field">
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" required />
          </label>
          <button class="button" type="submit">Enviar enlace de acceso</button>
        </form>
        <div id="loginMessage" class="${message ? "flash" : "hidden"}">${message}</div>
      </section>
    </main>
  `;

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = new FormData(event.currentTarget).get("email");
    const result = await api("/api/auth/request", { method: "POST", body: { email } });
    const link = result.devMagicUrl ? `<p><a href="${result.devMagicUrl}">Abrir enlace local</a></p>` : "";
    renderLogin(`${result.message}${link}`);
  });
}

function renderApp() {
  const { data } = state;
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          ${brandLogo()}
          <div>
            <h1>${escapeHtml(appConfig.choirName)}</h1>
            <p>${escapeHtml(data.program?.name || "Programa actual")}</p>
          </div>
        </div>
        <div class="userbar">
          <img class="avatar" src="${escapeAttr(data.user.avatarUrl)}" alt="" />
          <div class="user-identity">
            <strong>${escapeHtml(data.profile?.name || data.user.email)}</strong>
            <span>${escapeHtml(data.user.email)}</span>
          </div>
          ${data.user.role === "admin" ? '<span class="role-pill">Admin</span>' : ""}
          <button class="button secondary" id="logoutButton">Salir</button>
        </div>
      </header>

      <nav class="tabs">
        ${tab("calendar", "Calendario")}
        ${tab("resources", "Repertorio")}
        ${tab("profile", "Mis datos")}
        ${data.user.role === "admin" ? tab("admin", "Administración") : ""}
      </nav>

      <main id="view"></main>
    </div>
  `;
  document.querySelector("#logoutButton").addEventListener("click", logout);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      state.screen = event.currentTarget.dataset.tab;
      renderView();
    });
  });
  renderView();
}

function renderView() {
  const view = document.querySelector("#view");
  if (state.screen === "resources") view.innerHTML = resourcesView();
  else if (state.screen === "profile") view.innerHTML = profileView();
  else if (state.screen === "admin") view.innerHTML = adminView();
  else view.innerHTML = calendarView();
  syncTabs();
  bindView();
}

function calendarView() {
  const selectedEvents = eventsForDate(state.selectedDate);
  return `
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>${monthTitle(state.visibleMonth)}</h2>
            <p>Haz clic en una fecha para ver o marcar tu asistencia.</p>
          </div>
          <div class="month-actions">
            <button class="button secondary" data-month-step="-1" title="Mes anterior" ${isMonthAtBound("min") ? "disabled" : ""}>‹</button>
            <button class="button secondary" data-month-step="1" title="Mes siguiente" ${isMonthAtBound("max") ? "disabled" : ""}>›</button>
          </div>
        </div>
        <div class="panel-body">
          ${monthGrid()}
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <div>
            <h2>${state.selectedDate ? formatDate(state.selectedDate) : "Selecciona un día"}</h2>
            <p>${selectedEvents.length ? "Marca tu estado para esta fecha." : "No hay eventos ese día."}</p>
          </div>
        </div>
        <div class="panel-body event-list">
          ${selectedEvents.map(eventCard).join("") || memberSummary()}
        </div>
      </aside>
    </div>
  `;
}

function monthGrid() {
  const [year, month] = state.visibleMonth.split("-").map(Number);
  const first = new Date(year, month - 1, 1);
  const daysInMonth = new Date(year, month, 0).getDate();
  const mondayOffset = (first.getDay() + 6) % 7;
  const cells = [];

  for (let index = 0; index < mondayOffset; index += 1) {
    cells.push('<div class="month-cell empty"></div>');
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${state.visibleMonth}-${String(day).padStart(2, "0")}`;
    const events = eventsForDate(date);
    const hasMarked = events.some((event) => {
      const attendance = findAttendance(event.id);
      return attendance && attendance.status !== "coming";
    });
    cells.push(`
      <button class="month-cell ${events.length ? "has-events" : ""} ${date === state.selectedDate ? "selected" : ""}" data-date="${date}">
        <span class="day-number">${day}</span>
        <span class="day-events">
          ${events
            .map((event) => `<span class="day-dot ${event.type}">${escapeHtml(shortEventName(event))}</span>`)
            .join("")}
        </span>
        ${hasMarked ? '<span class="marked">Marcado</span>' : ""}
      </button>
    `);
  }

  return `
    <div class="weekdays">
      ${["L", "M", "X", "J", "V", "S", "D"].map((day) => `<span>${day}</span>`).join("")}
    </div>
    <div class="month-grid">${cells.join("")}</div>
  `;
}

function eventCard(event) {
  const attendance = findAttendance(event.id);
  const status = attendance?.status || "coming";
  return `
    <article class="event">
      <div class="datebox">
        <div>
          <small>${monthName(event.date)}</small>
          ${dayNumber(event.date)}
        </div>
      </div>
      <div>
        <span class="pill ${event.type}">${escapeHtml(event.type)}</span>
        <h3>${escapeHtml(event.title)}</h3>
        <div class="meta">
          <span>${formatDate(event.date)} · ${escapeHtml(event.time || "")}</span>
          <span>${escapeHtml(event.location || "")}</span>
        </div>
        ${event.notes ? `<p class="muted">${escapeHtml(event.notes)}</p>` : ""}
        <div class="attendance" data-event="${event.id}">
          <div class="segmented">
            ${Object.entries(statusLabels)
              .map(
                ([key, label]) =>
                  `<button data-status="${key}" class="${status === key ? "active" : ""}">${label}</button>`
              )
              .join("")}
          </div>
          <div class="note-row">
            <input value="${escapeAttr(attendance?.note || "")}" placeholder="Comentario opcional" />
            <button class="button secondary" data-save-note>Guardar</button>
          </div>
        </div>
      </div>
    </article>
  `;
}

function resourcesView() {
  const program = state.data.program || {};
  const playlists = program.playlists || {};
  const playlistLinks = [
    ["Apple Music", playlists.appleMusic],
    ["Spotify", playlists.spotify],
    ["YouTube", playlists.youtube]
  ].filter(([, url]) => url);
  return `
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Repertorio</h2>
            <p>Obras y materiales del programa activo.</p>
          </div>
        </div>
        <div class="panel-body resource-list">
          <article class="resource">
            ${resourceHeading("Obras", "Listado manual del programa")}
            ${program.works ? `<div class="works-list">${escapeHtml(program.works).replaceAll("\n", "<br />")}</div>` : empty("Todavía no hay obras escritas.")}
          </article>
          <article class="resource">
            ${resourceHeading("Partituras", "Carpeta compartida")}
            <h3><a href="${escapeAttr(program.scoreFolderUrl || "")}" target="_blank" rel="noreferrer">Carpeta de partituras</a></h3>
          </article>
          <article class="resource">
            ${resourceHeading("Listas de reproducción", "Apple Music, Spotify y YouTube")}
            ${playlistLinks.length ? playlistLinks.map(([label, url]) => `<p><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></p>`).join("") : empty("Todavía no hay listas de reproducción.")}
          </article>
          ${state.data.resources.filter((resource) => resource.type !== "partituras").map(resourceCard).join("")}
        </div>
      </section>
      ${
        state.data.user.role === "admin"
          ? `<aside class="panel">
              <div class="panel-head">
                <div>
                  <h2>Editar repertorio</h2>
                  <p>Actualiza obras y listas para todos.</p>
                </div>
              </div>
              <div class="panel-body">
                <form id="programForm">
                  <label class="field"><span>Nombre del programa</span><input name="name" value="${escapeAttr(program.name || "")}" /></label>
                  <label class="field"><span>Descripción</span><textarea name="description">${escapeHtml(program.description || "")}</textarea></label>
                  <label class="field"><span>Listado de obras</span><textarea class="tall" name="works">${escapeHtml(program.works || "")}</textarea></label>
                  <label class="field"><span>Carpeta de partituras</span><input name="scoreFolderUrl" value="${escapeAttr(program.scoreFolderUrl || "")}" /></label>
                  <label class="field"><span>Apple Music</span><input name="appleMusic" value="${escapeAttr(playlists.appleMusic || "")}" /></label>
                  <label class="field"><span>Spotify</span><input name="spotify" value="${escapeAttr(playlists.spotify || "")}" /></label>
                  <label class="field"><span>YouTube</span><input name="youtube" value="${escapeAttr(playlists.youtube || "")}" /></label>
                  <button class="button" type="submit">Guardar repertorio</button>
                </form>
              </div>
            </aside>`
          : ""
      }
    </div>
  `;
}

function resourceCard(resource) {
  return `
    <article class="resource">
      ${resourceHeading(resource.type || "Enlace", "Recurso adicional")}
      <h3><a href="${escapeAttr(resource.url)}" target="_blank" rel="noreferrer">${escapeHtml(resource.title)}</a></h3>
      ${resource.notes ? `<p class="muted">${escapeHtml(resource.notes)}</p>` : ""}
    </article>
  `;
}

function profileView() {
  const profile = state.data.profile || {};
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Mis datos</h2>
          <p>Estos datos ayudan a ordenar los resúmenes del director.</p>
        </div>
      </div>
      <div class="panel-body">
        <form id="profileForm" class="form-grid">
          <label class="field">
            <span>Nombre</span>
            <input name="name" value="${escapeAttr(profile.name || "")}" />
          </label>
          <label class="field">
            <span>Cuerda</span>
            <select name="voice">
              ${["", "Soprano", "Alto", "Tenor", "Bajo"].map((voice) => option(voice, normalizedVoice(profile.voice))).join("")}
            </select>
          </label>
          <div class="wide">
            <button class="button" type="submit">Guardar mis datos</button>
          </div>
        </form>
      </div>
    </section>
  `;
}

function adminView() {
  if (!state.admin) return empty("Cargando panel admin.");
  const activeProgramId = state.admin.program?.id || "";
  return `
    <div class="grid">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Ausencias y retrasos</h2>
            <p>Esta información sólo está disponible para administradores.</p>
          </div>
        </div>
        <div class="panel-body summary-list">
          ${state.admin.events.map(adminEventSummary).join("") || empty("Todavía no hay eventos.")}
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <div>
            <h2>Editar contenido</h2>
            <p>Añade eventos y enlaces al programa activo.</p>
          </div>
        </div>
        <div class="panel-body">
          <form id="eventForm">
            <input type="hidden" name="programId" value="${escapeAttr(activeProgramId)}" />
            <label class="field"><span>Título</span><input name="title" required /></label>
            <div class="form-grid">
              <label class="field"><span>Tipo</span><select name="type"><option>ensayo</option><option>concierto</option><option>otro</option></select></label>
              <label class="field"><span>Fecha</span><input name="date" type="date" required /></label>
              <label class="field"><span>Hora</span><input name="time" placeholder="20:00" /></label>
              <label class="field"><span>Lugar</span><input name="location" /></label>
            </div>
            <label class="field"><span>Notas</span><textarea name="notes"></textarea></label>
            <button class="button" type="submit">Añadir evento</button>
          </form>
          <hr />
          <form id="resourceForm">
            <input type="hidden" name="programId" value="${escapeAttr(activeProgramId)}" />
            <label class="field"><span>Título</span><input name="title" required /></label>
            <label class="field"><span>Tipo</span><input name="type" placeholder="partituras, audios, enlace" /></label>
            <label class="field"><span>URL</span><input name="url" type="url" required /></label>
            <label class="field"><span>Notas</span><textarea name="notes"></textarea></label>
            <button class="button secondary" type="submit">Añadir enlace</button>
          </form>
          <hr />
          <form id="resetProgramForm" class="danger-zone">
            <h3>Nuevo programa</h3>
            <p class="muted">Borra eventos, asistencias y repertorio del programa actual. Conserva cantantes, cuerdas y sesiones.</p>
            <label class="field"><span>Nombre del siguiente programa</span><input name="name" placeholder="Nuevo programa" required /></label>
            <label class="field"><span>Descripción</span><textarea name="description"></textarea></label>
            <button class="button danger" type="submit">Borrar programa actual y empezar otro</button>
          </form>
        </div>
      </aside>
    </div>
  `;
}

function adminEventSummary(event) {
  const rows = state.admin.allAttendance.filter((item) => item.eventId === event.id);
  const absent = rows.filter((item) => item.status === "absent");
  const late = rows.filter((item) => item.status === "late");
  return `
    <article class="summary-event">
      <h3>${escapeHtml(event.title)} · ${formatDate(event.date)}</h3>
      <form class="event-edit-form" data-event-edit="${escapeAttr(event.id)}">
        <div class="form-grid">
          <label class="field"><span>Título</span><input name="title" value="${escapeAttr(event.title)}" /></label>
          <label class="field"><span>Tipo</span><select name="type">${["ensayo", "concierto", "otro"].map((type) => option(type, event.type)).join("")}</select></label>
          <label class="field"><span>Fecha</span><input name="date" type="date" value="${escapeAttr(event.date)}" /></label>
          <label class="field"><span>Hora</span><input name="time" value="${escapeAttr(event.time || "")}" /></label>
          <label class="field wide"><span>Lugar</span><input name="location" value="${escapeAttr(event.location || "")}" /></label>
          <label class="field wide"><span>Notas para esta fecha</span><textarea name="notes">${escapeHtml(event.notes || "")}</textarea></label>
        </div>
        <button class="button secondary" type="submit">Guardar fecha</button>
      </form>
      <div class="summary-columns">
        <div class="summary-box">
          <strong>No asistirán</strong>
          ${groupedPeople(absent)}
        </div>
        <div class="summary-box">
          <strong>Llegarán tarde</strong>
          ${groupedPeople(late)}
        </div>
      </div>
    </article>
  `;
}

function personLine(item) {
  const profile = state.admin.profiles.find((profileItem) => profileItem.email === item.email);
  const name = profile?.name || item.email;
  const note = item.note ? ` · ${item.note}` : "";
  return `<span class="person">${escapeHtml(name + note)}</span>`;
}

function memberSummary() {
  const notable = state.data.attendance.filter((item) => item.status !== "coming");
  if (!notable.length) return '<p class="muted">No has marcado ausencias ni retrasos.</p>';
  return notable
    .map((item) => {
      const event = state.data.events.find((eventItem) => eventItem.id === item.eventId);
      return `<p><strong>${statusLabels[item.status]}</strong><br /><span class="muted">${escapeHtml(event?.title || "")} · ${formatDate(event?.date)}</span></p>`;
    })
    .join("");
}

function bindView() {
  document.querySelectorAll("[data-month-step]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.disabled) return;
      state.visibleMonth = shiftMonth(state.visibleMonth, Number(button.dataset.monthStep));
      const events = eventsForMonth(state.visibleMonth);
      state.selectedDate = events[0]?.date || `${state.visibleMonth}-01`;
      renderView();
    });
  });

  document.querySelectorAll("[data-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDate = button.dataset.date;
      renderView();
    });
  });

  document.querySelectorAll(".attendance").forEach((block) => {
    block.querySelectorAll("[data-status]").forEach((button) => {
      button.addEventListener("click", () => saveAttendance(block, button.dataset.status));
    });
    block.querySelector("[data-save-note]")?.addEventListener("click", () => {
      const current = findAttendance(block.dataset.event)?.status || "coming";
      saveAttendance(block, current);
    });
  });

  document.querySelector("#profileForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/me/profile", { method: "PUT", body: formBody(event.currentTarget) });
    await refresh();
    state.screen = "profile";
    renderApp();
  });

  document.querySelector("#eventForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/events", { method: "POST", body: formBody(event.currentTarget) });
    event.currentTarget.reset();
    await refreshAdmin();
  });

  document.querySelector("#resourceForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/resources", { method: "POST", body: formBody(event.currentTarget) });
    event.currentTarget.reset();
    await refreshAdmin();
  });

  document.querySelector("#programForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await api("/api/admin/program", { method: "PUT", body: formBody(event.currentTarget) });
    await refreshAdmin();
    state.screen = "resources";
    renderApp();
  });

  document.querySelector("#resetProgramForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const confirmed = window.confirm(
      "Esto borrará eventos, asistencias y repertorio del programa actual. ¿Quieres continuar?"
    );
    if (!confirmed) return;
    await api("/api/admin/program/reset", { method: "POST", body: formBody(event.currentTarget) });
    state.visibleMonth = "";
    state.selectedDate = "";
    await refreshAdmin();
  });

  document.querySelectorAll("[data-event-edit]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await api(`/api/admin/events/${form.dataset.eventEdit}`, {
        method: "PUT",
        body: formBody(form)
      });
      await refreshAdmin();
    });
  });
}

async function saveAttendance(block, status) {
  await api(`/api/attendance/${block.dataset.event}`, {
    method: "PUT",
    body: { status, note: block.querySelector("input").value }
  });
  await refresh();
  renderApp();
}

async function refresh() {
  state.data = await api("/api/data");
  if (state.data.user.role === "admin") state.admin = await api("/api/admin");
  initCalendarState();
}

async function refreshAdmin() {
  state.data = await api("/api/data");
  state.admin = await api("/api/admin");
  state.screen = "admin";
  renderApp();
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  renderLogin();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Error");
  return payload;
}

function formBody(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function brandLogo() {
  return `
    <div class="logo-wrap">
      <img class="logo-img" src="/logo.jpg" alt="${escapeAttr(appConfig.choirName)}" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')" />
      <span class="logo-fallback hidden">AM</span>
    </div>
  `;
}

function resourceHeading(title, subtitle) {
  return `
    <header class="resource-heading">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
    </header>
  `;
}

function initCalendarState() {
  const firstEvent = state.data?.events?.[0];
  const bounds = calendarBounds();
  if (!state.visibleMonth) state.visibleMonth = firstEvent?.date?.slice(0, 7) || bounds.min;
  if (state.visibleMonth < bounds.min) state.visibleMonth = bounds.min;
  if (state.visibleMonth > bounds.max) state.visibleMonth = bounds.max;
  if (!state.selectedDate) {
    state.selectedDate = eventsForMonth(state.visibleMonth)[0]?.date || firstEvent?.date || todayIso();
  }
}

function syncTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.screen);
  });
}

function tab(key, label) {
  return `<button class="tab ${state.screen === key ? "active" : ""}" data-tab="${key}">${label}</button>`;
}

function option(value, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(value || "Sin indicar")}</option>`;
}

function findAttendance(eventId) {
  return state.data.attendance.find((item) => item.eventId === eventId);
}

function eventsForDate(date) {
  return (state.data.events || []).filter((event) => event.date === date);
}

function eventsForMonth(month) {
  return (state.data.events || []).filter((event) => event.date?.startsWith(month));
}

function calendarBounds() {
  const months = (state.data?.events || []).map((event) => event.date?.slice(0, 7)).filter(Boolean);
  if (!months.length) return { min: todayMonth(), max: todayMonth() };
  const sortedMonths = [...months].sort();
  const minEventMonth = sortedMonths[0];
  const maxEventMonth = sortedMonths[sortedMonths.length - 1];
  return {
    min: shiftMonth(minEventMonth, -1),
    max: maxEventMonth
  };
}

function isMonthAtBound(bound) {
  const bounds = calendarBounds();
  return bound === "min" ? state.visibleMonth <= bounds.min : state.visibleMonth >= bounds.max;
}

function shiftMonth(month, step) {
  const [year, monthIndex] = month.split("-").map(Number);
  const date = new Date(year, monthIndex - 1 + step, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function todayMonth() {
  return todayIso().slice(0, 7);
}

function monthTitle(month) {
  const [year, monthIndex] = month.split("-").map(Number);
  const title = new Intl.DateTimeFormat("es", {
    month: "long",
    year: "numeric"
  }).format(new Date(year, monthIndex - 1, 1));
  return title.charAt(0).toUpperCase() + title.slice(1);
}

function shortEventName(event) {
  if (event.type === "ensayo") return "Ensayo";
  if (event.type === "concierto") return "Concierto";
  return event.title;
}

function groupedPeople(items) {
  if (!items.length) return '<span class="person">Sin avisos</span>';
  const order = ["Soprano", "Alto", "Tenor", "Bajo", "Sin cuerda"];
  const groups = Object.fromEntries(order.map((voice) => [voice, []]));
  items.forEach((item) => {
    const profile = state.admin.profiles.find((profileItem) => profileItem.email === item.email);
    const voice = normalizedVoice(profile?.voice) || "Sin cuerda";
    groups[voice].push(item);
  });
  return order
    .filter((voice) => groups[voice].length)
    .map(
      (voice) => `
        <div class="voice-group">
          <strong>${escapeHtml(voice)}</strong>
          ${groups[voice].map(personLine).join("")}
        </div>
      `
    )
    .join("");
}

function normalizedVoice(voice) {
  return voice === "Contralto" ? "Alto" : voice || "";
}

function dayNumber(date) {
  return date ? Number(date.slice(8, 10)) : "";
}

function monthName(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("es", { month: "short" }).format(new Date(`${date}T12:00:00`));
}

function formatDate(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("es", {
    weekday: "short",
    day: "numeric",
    month: "long"
  }).format(new Date(`${date}T12:00:00`));
}

function empty(text) {
  return `<p class="muted">${escapeHtml(text)}</p>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("'", "&#039;");
}
