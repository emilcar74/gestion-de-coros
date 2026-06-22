const state = {
  screen: "calendar",
  visibleMonth: "",
  selectedDate: "",
  selectedPracticeWork: "",
  data: null,
  admin: null,
  materials: null
};

const appConfig = {
  choirName: "Ars Mvsica",
  loginSubtitle: "Zona privada para cantantes. Entra con tu email registrado.",
  buildVersion: "20260622-5"
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
    state.materials = await api("/api/materials");
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
        ${buildMark()}
      </section>
    </main>
  `;

  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    const email = new FormData(form).get("email");
    button.disabled = true;
    try {
      const result = await api("/api/auth/request", { method: "POST", body: { email } });
      if (result.redirectTo) {
        window.location.href = result.redirectTo;
        return;
      }
      const link = result.devMagicUrl ? `<p><a href="${result.devMagicUrl}">Abrir enlace local</a></p>` : "";
      renderLogin(`${result.message}${link}`);
    } catch (error) {
      renderLogin(error.message || "No se pudo solicitar el enlace. Revisa la conexión e inténtalo de nuevo.");
    }
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
            <p class="program-title"><span>Programa</span>${escapeHtml(data.program?.name || "Programa actual")}</p>
          </div>
        </div>
        <div class="userbar">
          <img class="avatar" src="${escapeAttr(data.user.avatarUrl)}" alt="" />
          <div class="user-identity">
            <strong>${escapeHtml(data.profile?.name || data.user.email)}</strong>
            <span>${escapeHtml(data.user.email)}</span>
          </div>
          ${data.user.role === "admin" ? '<span class="role-pill">Admin</span>' : ""}
          ${data.user.demo ? '<span class="role-pill demo">Demo</span>' : ""}
          <button class="button secondary" id="logoutButton">Salir</button>
          ${buildMark()}
        </div>
      </header>

      <nav class="tabs">
        ${tab("calendar", "Calendario")}
        ${tab("resources", "Repertorio")}
        ${hasPracticeMode() ? tab("practice", "Ensayo individual") : ""}
        ${tab("profile", "Mis datos")}
        ${data.user.role === "admin" ? tab("admin", "Administración") : ""}
        ${data.user.role === "admin" ? tab("choir", "Coro") : ""}
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
  if (state.screen === "practice" && !hasPracticeMode()) state.screen = "resources";
  if (state.screen === "resources") view.innerHTML = resourcesView();
  else if (state.screen === "practice") view.innerHTML = practiceView();
  else if (state.screen === "profile") view.innerHTML = profileView();
  else if (state.screen === "admin") view.innerHTML = adminView();
  else if (state.screen === "choir") view.innerHTML = choirView();
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
    cells.push(`
      <button class="month-cell ${events.length ? "has-events" : ""} ${date === state.selectedDate ? "selected" : ""}" data-date="${date}">
        <span class="day-number">${day}</span>
        <span class="day-events">
          ${events
            .map((event) => {
              const attendance = findAttendance(event.id);
              const exception = attendance && attendance.status !== "coming" ? attendance.status : "";
              return `<span class="day-dot ${event.type} ${exception}" title="${escapeAttr(exception ? statusLabels[exception] : shortEventName(event))}">${escapeHtml(shortEventName(event))}</span>`;
            })
            .join("")}
        </span>
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
  const status = attendance?.status || "";
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
        ${event.notes ? `<div class="markdown event-notes">${renderMarkdown(event.notes)}</div>` : ""}
        <div class="attendance" data-event="${event.id}">
          <div class="segmented">
            ${Object.entries(statusLabels)
              .map(
                ([key, label]) =>
                  `<button data-status="${key}" class="${status === key ? "active" : ""}">${label}</button>`
              )
              .join("")}
          </div>
          ${status ? "" : '<p class="attendance-state">Sin respuesta</p>'}
          ${
            status === "late" || status === "absent"
              ? `<div class="note-row">
                  <input value="${escapeAttr(attendance?.note || "")}" placeholder="Comentario opcional" />
                  <button class="button secondary" type="button" data-save-note>Guardar</button>
                </div>`
              : ""
          }
        </div>
      </div>
    </article>
  `;
}

function resourcesView() {
  const program = state.data.program || {};
  const materials = state.materials || {};
  const mode = programMaterialMode(program);
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
            ${program.works ? `<div class="markdown works-list">${renderMarkdown(program.works)}</div>` : empty("Todavía no hay obras escritas.")}
          </article>
          <article class="resource">
            ${resourceHeading("Materiales", mode === "server" ? "Carpeta protegida" : "Enlace externo")}
            ${materialResourcesView(materials, program)}
          </article>
          <article class="resource">
            ${resourceHeading("Instrucciones de ensayo", "Indicaciones para preparar el repertorio")}
            ${program.rehearsalInstructions ? `<div class="markdown works-list">${renderMarkdown(program.rehearsalInstructions)}</div>` : empty("Todavía no hay instrucciones de ensayo.")}
          </article>
          <article class="resource">
            ${resourceHeading("Listas de reproducción", "Apple Music, Spotify y YouTube")}
            ${playlistLinks.length ? `<div class="playlist-links">${playlistLinks.map(playlistLink).join("")}</div>` : empty("Todavía no hay listas de reproducción.")}
          </article>
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
                  ${materialAdminFields(program)}
                  <label class="field"><span>Instrucciones de ensayo</span><textarea class="tall" name="rehearsalInstructions">${escapeHtml(program.rehearsalInstructions || "")}</textarea></label>
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

function materialAdminFields(program = {}) {
  const mode = programMaterialMode(program);
  return `
    <label class="field">
      <span>Materiales</span>
      <select name="materialMode" data-material-mode>
        <option value="external" ${mode === "external" ? "selected" : ""}>Carpeta de Google Drive</option>
        <option value="server" ${mode === "server" ? "selected" : ""}>Servidor privado</option>
      </select>
    </label>
    <div data-material-fields="external" ${mode === "external" ? "" : "hidden"}>
      <label class="field"><span>Enlace a la carpeta</span><input name="scoreFolderUrl" placeholder="https://drive.google.com/..." value="${escapeAttr(program.scoreFolderUrl || "")}" /></label>
    </div>
    <div data-material-fields="server" ${mode === "server" ? "" : "hidden"}>
      <label class="field">
        <span>Carpeta en el servidor</span>
        <small>/opt/ars-mvsica-privado/media/rehearsal/</small>
        <input name="materialFolder" placeholder="navidad-2026" value="${escapeAttr(program.materialFolder || "")}" />
      </label>
      <label class="field"><span>Obras para ensayo individual</span><textarea class="tall" name="practiceWorks" placeholder="O magnum mysterium | Victoria - O magnum mysterium">${escapeHtml(program.practiceWorks || "")}</textarea></label>
    </div>
  `;
}

function materialResourcesView(materials, program) {
  if (programMaterialMode(program) !== "server") {
    if (!program.scoreFolderUrl) return empty("Todavía no hay enlace de materiales configurado.");
    return `<a class="button secondary" href="${escapeAttr(program.scoreFolderUrl)}" target="_blank" rel="noreferrer">Abrir carpeta de materiales</a>`;
  }
  return materialFolderView(materials, program);
}

function materialFolderView(materials, program) {
  if (!program.materialFolder) return empty("Todavía no hay carpeta de materiales configurada.");
  const files = materials.files || [];
  if (!files.length) return empty("La carpeta no tiene archivos PDF o MP3 disponibles.");
  const pdfs = files.filter((file) => file.type === "pdf");
  const audios = files.filter((file) => file.type === "audio");
  return `
    <div class="material-browser">
      ${materialFileGroup("PDF", pdfs)}
      ${materialFileGroup("Audios", audios)}
    </div>
  `;
}

function materialFileGroup(title, files) {
  if (!files.length) return "";
  return `
    <div class="material-file-group">
      <h4>${escapeHtml(title)}</h4>
      <div class="material-files">
        ${files.map(materialFileLink).join("")}
      </div>
    </div>
  `;
}

function materialFileLink(file) {
  return `
    <a class="material-file-link" href="${escapeAttr(file.url)}" target="_blank" rel="noreferrer">
      <span>${file.type === "pdf" ? "PDF" : "MP3"}</span>
      ${escapeHtml(file.name)}
    </a>
  `;
}

function practiceView() {
  const materials = state.materials || {};
  const works = materials.works || [];
  const selected = works.find((work) => work.title === state.selectedPracticeWork) || works[0] || null;
  if (selected && state.selectedPracticeWork !== selected.title) state.selectedPracticeWork = selected.title;

  return `
    <div class="practice-layout">
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>Ensayo individual</h2>
            <p>Escucha tu cuerda y sigue la partitura de la obra seleccionada.</p>
          </div>
        </div>
        <div class="panel-body">
          ${practiceWorkList(works)}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <div>
            <h2>${selected ? escapeHtml(selected.title) : "Obra"}</h2>
            <p>${practiceSubtitle()}</p>
          </div>
        </div>
        <div class="panel-body">
          ${selected ? practiceWorkDetail(selected) : empty("Todavía no hay obras configuradas para ensayo individual.")}
        </div>
      </section>
    </div>
  `;
}

function practiceWorkList(works) {
  if (!works.length) return empty("Todavía no hay obras configuradas.");
  return `
    <div class="practice-work-list">
      ${works
        .map(
          (work) => `
            <button class="${work.title === state.selectedPracticeWork ? "active" : ""}" type="button" data-practice-work="${escapeAttr(work.title)}">
              <span>${escapeHtml(work.title)}</span>
              <small>${practiceAvailability(work)}</small>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function practiceWorkDetail(work) {
  const voice = normalizedVoice(state.data.profile?.voice);
  const audios = voice ? work.audios.filter((audio) => audio.voice === voice || audio.voice.startsWith(`${voice} `)) : [];
  return `
    <div class="practice-detail">
      ${
        voice
          ? ""
          : '<p class="flash inline-flash">Indica tu cuerda en Mis datos para cargar el audio correspondiente.</p>'
      }
      <div class="practice-audios">
        ${
          audios.length
            ? audios.map(practiceAudio).join("")
            : empty(voice ? `No hay audio disponible para ${voice}.` : "No hay audio de cuerda seleccionado.")
        }
      </div>
      <div class="practice-score">
        ${
          work.pdf
            ? `<div class="practice-score-actions"><a class="button secondary" href="${escapeAttr(work.pdf.url)}" target="_blank" rel="noreferrer">Abrir PDF</a></div><iframe src="${escapeAttr(work.pdf.url)}" title="${escapeAttr(work.title)}"></iframe>`
            : empty("No hay PDF disponible para esta obra.")
        }
      </div>
    </div>
  `;
}

function practiceAudio(audio) {
  return `
    <div class="practice-audio">
      <strong>${escapeHtml(audio.voice)}</strong>
      <audio controls src="${escapeAttr(audio.url)}"></audio>
    </div>
  `;
}

function practiceAvailability(work) {
  const parts = [];
  if (work.pdf) parts.push("PDF");
  if (work.audios.length) parts.push(`${work.audios.length} audio${work.audios.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "Sin archivos";
}

function practiceSubtitle() {
  const voice = normalizedVoice(state.data.profile?.voice);
  return voice ? `Audio para ${voice}` : "Configura tu cuerda en Mis datos";
}

function playlistLink([label, url]) {
  return `
    <a class="playlist-link playlist-${playlistSlug(label)}" href="${escapeAttr(url)}" target="_blank" rel="noreferrer">
      ${playlistIcon(label)}
      <span>${escapeHtml(label)}</span>
    </a>
  `;
}

function playlistSlug(label) {
  return label.toLowerCase().replaceAll(" ", "-");
}

function playlistIcon(label) {
  if (label === "Spotify") {
    return `
      <span class="playlist-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <circle cx="12" cy="12" r="10" />
          <path d="M7.2 9.4c3.1-1 6.8-.7 9.7.9" />
          <path d="M8 12.3c2.5-.7 5.2-.5 7.5.7" />
          <path d="M8.7 15c1.8-.5 3.9-.3 5.6.6" />
        </svg>
      </span>
    `;
  }
  if (label === "YouTube") {
    return `
      <span class="playlist-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="3" y="6.5" width="18" height="11" rx="3" />
          <path d="M10.3 9.2v5.6l5-2.8z" />
        </svg>
      </span>
    `;
  }
  return `
    <span class="playlist-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M16.5 4.8v10.1a3.1 3.1 0 1 1-1.8-2.8V6.4L8.8 7.7v8.8A3.1 3.1 0 1 1 7 13.7V6.4z" />
      </svg>
    </span>
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
          <label class="field">
            <span>Partituras</span>
            <select name="scoreFormat">
              ${["", "Papel", "Digital"].map((format) => option(format, normalizedScoreFormat(profile.scoreFormat))).join("")}
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
            <p>Añade eventos al programa activo.</p>
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
            <label class="check-field">
              <input name="notifyChoir" type="checkbox" />
              <span>Avisar al coro por email</span>
            </label>
            <button class="button" type="submit">Añadir evento</button>
          </form>
          <hr />
          <form id="logoForm">
            <h3>Logotipo</h3>
            <label class="field"><span>Nuevo logotipo</span><input name="logo" type="file" accept="image/jpeg,image/png" required /></label>
            <button class="button secondary" type="submit">Cambiar logotipo</button>
          </form>
          <hr />
          <form id="resetProgramForm" class="danger-zone">
            <h3>Nuevo programa</h3>
            <p class="muted">Borra eventos, asistencias y repertorio del programa actual. Conserva cantantes, cuerdas y sesiones.</p>
            <label class="field"><span>Nombre del siguiente programa</span><input name="name" placeholder="Nuevo programa" required /></label>
            <label class="field"><span>Descripción</span><textarea name="description"></textarea></label>
            ${materialAdminFields({ materialMode: "external" })}
            <button class="button danger" type="submit">Borrar programa actual y empezar otro</button>
          </form>
        </div>
      </aside>
    </div>
  `;
}

function adminEventSummary(event) {
  const rows = state.admin.allAttendance.filter((item) => item.eventId === event.id);
  const coming = rows.filter((item) => item.status === "coming");
  const absent = rows.filter((item) => item.status === "absent");
  const late = rows.filter((item) => item.status === "late");
  const answeredEmails = new Set(rows.map((item) => item.email));
  const noResponse = singerProfiles().filter((profile) => !answeredEmails.has(profile.email));
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
        <div class="event-actions">
          <button class="button secondary" type="submit">Guardar fecha</button>
          <button class="button danger" type="button" data-event-delete="${escapeAttr(event.id)}">Borrar evento</button>
        </div>
      </form>
      <div class="summary-columns summary-columns-primary">
        <div class="summary-box summary-box-coming">
          ${summaryTitle("Asistirán", coming)}
          ${groupedPeople(coming)}
        </div>
        <div class="summary-box summary-box-pending">
          ${summaryTitle("Sin respuesta", noResponse)}
          ${groupedPeople(noResponse)}
        </div>
      </div>
      <div class="summary-columns">
        <div class="summary-box summary-box-absent">
          ${summaryTitle("No asistirán", absent)}
          ${groupedPeople(absent)}
        </div>
        <div class="summary-box summary-box-late">
          ${summaryTitle("Llegarán tarde", late)}
          ${groupedPeople(late)}
        </div>
      </div>
    </article>
  `;
}

function choirView() {
  if (!state.admin) return empty("Cargando listado del coro.");
  return `
    <section class="panel">
      <div class="panel-head">
        <div>
          <h2>Coro</h2>
          <p>Gestiona cantantes registrados en la zona privada.</p>
        </div>
      </div>
      <div class="panel-body choir-list">
        ${scoreFormatSummary()}
        ${groupedProfiles().map(choirVoiceGroup).join("")}
      </div>
    </section>
  `;
}

function scoreFormatSummary() {
  const profiles = singerProfiles();
  const counts = profiles.reduce(
    (totals, profile) => {
      const format = normalizedScoreFormat(profile.scoreFormat);
      totals[format || "Sin partituras"] += 1;
      return totals;
    },
    { Papel: 0, Digital: 0, "Sin partituras": 0 }
  );
  return `
    <div class="score-summary" aria-label="Resumen de preferencias de partituras">
      ${scoreSummaryItem("Papel", counts.Papel)}
      ${scoreSummaryItem("Digital", counts.Digital)}
      ${scoreSummaryItem("Sin partituras", counts["Sin partituras"])}
    </div>
  `;
}

function scoreSummaryItem(label, count) {
  return `
    <div class="score-summary-item">
      <span>${escapeHtml(label)}</span>
      <strong>${count}</strong>
    </div>
  `;
}

function choirVoiceGroup(group) {
  return `
    <article class="choir-group">
      <header>
        <h3>${escapeHtml(group.voice)}</h3>
        <span>${group.profiles.length}</span>
      </header>
      <div class="choir-members">
        ${group.profiles.map(choirMemberRow).join("")}
      </div>
    </article>
  `;
}

function choirMemberRow(profile) {
  const attendanceCount = state.admin.allAttendance.filter((item) => item.email === profile.email).length;
  const isCurrentUser = profile.email === state.data.user.email;
  return `
    <div class="choir-member">
      <div>
        <strong>${escapeHtml(profile.name || "Sin nombre")}</strong>
        <span>${escapeHtml(profile.email)}</span>
      </div>
      <div class="choir-member-meta">
        <span>${escapeHtml(normalizedScoreFormat(profile.scoreFormat) || "Sin partituras")}</span>
        <span>${attendanceCount} respuestas</span>
        <button class="button danger" type="button" data-profile-delete="${escapeAttr(profile.email)}" ${isCurrentUser ? "disabled" : ""}>Eliminar</button>
      </div>
    </div>
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

function singerProfiles() {
  return state.admin.profiles.filter((profile) => profile.email !== state.data.user.email);
}

function groupedProfiles() {
  const order = ["Soprano", "Alto", "Tenor", "Bajo", "Sin cuerda"];
  const groups = Object.fromEntries(order.map((voice) => [voice, []]));
  state.admin.profiles.forEach((profile) => {
    const voice = normalizedVoice(profile.voice) || "Sin cuerda";
    if (!groups[voice]) groups[voice] = [];
    groups[voice].push(profile);
  });
  return order
    .filter((voice) => groups[voice].length)
    .map((voice) => ({
      voice,
      profiles: groups[voice].sort((a, b) =>
        (a.name || a.email).localeCompare(b.name || b.email, "es")
      )
    }));
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
    await runAction(async () => {
      await api("/api/me/profile", { method: "PUT", body: formBody(event.currentTarget) });
      await refresh();
      state.screen = "profile";
      renderApp();
      showToast("Datos guardados.");
    });
  });

  document.querySelector("#eventForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    await runAction(async () => {
      const result = await api("/api/admin/events", { method: "POST", body: formBody(form) });
      form.reset();
      await refreshAdmin();
      showToast(eventNoticeMessage(result.notice));
    });
  });

  document.querySelector("#programForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(async () => {
      await api("/api/admin/program", { method: "POST", body: formBody(event.currentTarget) });
      state.screen = "resources";
      await refresh();
      showToast("Repertorio guardado.");
      renderApp();
    });
  });

  document.querySelectorAll("[data-material-mode]").forEach((select) => {
    select.addEventListener("change", () => syncMaterialFields(select.form));
    syncMaterialFields(select.form);
  });

  document.querySelector("#logoForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.logo.files?.[0];
    if (!file) return;
    await runAction(async () => {
      const image = await fileToDataUrl(file);
      await api("/api/admin/logo", { method: "POST", body: { image } });
      form.reset();
      await refreshAdmin();
      showToast("Logotipo actualizado.");
    });
  });

  document.querySelector("#resetProgramForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const confirmed = window.confirm(
      "Esto borrará eventos, asistencias y repertorio del programa actual. ¿Quieres continuar?"
    );
    if (!confirmed) return;
    await runAction(async () => {
      await api("/api/admin/program/reset", { method: "POST", body: formBody(event.currentTarget) });
      state.visibleMonth = "";
      state.selectedDate = "";
      await refreshAdmin();
    });
  });

  document.querySelectorAll("[data-event-edit]").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await runAction(async () => {
        await api(`/api/admin/events/${form.dataset.eventEdit}`, {
          method: "PUT",
          body: formBody(form)
        });
        await refreshAdmin();
        showToast("Fecha guardada.");
      });
    });
  });

  document.querySelectorAll("[data-event-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const form = button.closest("[data-event-edit]");
      const title = form?.querySelector('input[name="title"]')?.value || "este evento";
      const confirmed = window.confirm(`¿Quieres borrar "${title}"? También se borrarán sus avisos de asistencia.`);
      if (!confirmed) return;
      await runAction(async () => {
        await api(`/api/admin/events/${button.dataset.eventDelete}`, { method: "DELETE" });
        await refreshAdmin();
        showToast("Evento borrado.");
      });
    });
  });

  document.querySelectorAll("[data-profile-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const email = button.dataset.profileDelete;
      const confirmed = window.confirm(
        `¿Quieres eliminar el perfil ${email}? También se borrarán sus respuestas y sesiones.`
      );
      if (!confirmed) return;
      await runAction(async () => {
        await api(`/api/admin/profiles/${encodeURIComponent(email)}`, { method: "DELETE" });
        await refreshAdmin();
        state.screen = "choir";
        renderApp();
        showToast("Perfil eliminado.");
      });
    });
  });

  document.querySelectorAll("[data-practice-work]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedPracticeWork = button.dataset.practiceWork;
      renderView();
    });
  });
}

async function saveAttendance(block, status) {
  await runAction(async () => {
    const note = status === "coming" ? "" : block.querySelector("input")?.value || "";
    await api(`/api/attendance/${block.dataset.event}`, {
      method: "PUT",
      body: { status, note }
    });
    await refresh();
    renderApp();
    showToast("Asistencia guardada.");
  });
}

async function refresh() {
  state.data = await api("/api/data");
  state.materials = await api("/api/materials");
  if (state.data.user.role === "admin") state.admin = await api("/api/admin");
  initCalendarState();
}

async function refreshAdmin() {
  state.data = await api("/api/data");
  state.materials = await api("/api/materials");
  state.admin = await api("/api/admin");
  state.screen = "admin";
  renderApp();
}

function eventNoticeMessage(notice) {
  if (!notice) return "Evento añadido.";
  if (notice.skipped) return `Evento añadido. ${notice.message || "No se enviaron avisos."}`;
  if (notice.error) return `Evento añadido, pero no se pudo avisar al coro: ${notice.error}`;
  if (notice.failed) return `Evento añadido. Avisos enviados: ${notice.sent}. Fallidos: ${notice.failed}.`;
  return `Evento añadido. Avisos enviados: ${notice.sent}.`;
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  renderLogin();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Error");
  return payload;
}

async function runAction(action) {
  try {
    await action();
  } catch (error) {
    showToast(error.message || "No se pudo guardar. Revisa la conexión.", "error");
  }
}

function showToast(message, type = "success") {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.type = type;
  toast.classList.add("visible");
  window.setTimeout(() => toast.classList.remove("visible"), 4200);
}

function formBody(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function syncMaterialFields(form) {
  if (!form) return;
  const mode = form.elements.materialMode?.value || "external";
  form.querySelectorAll("[data-material-fields]").forEach((group) => {
    group.hidden = group.dataset.materialFields !== mode;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      reject(new Error("El logo debe ser JPG o PNG."));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      reject(new Error("El logo debe ocupar menos de 2 MB."));
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("No se pudo leer la imagen.")));
    reader.readAsDataURL(file);
  });
}

function brandLogo() {
  return `
    <div class="logo-wrap">
      <img class="logo-img" src="${escapeAttr(logoUrl())}" alt="${escapeAttr(appConfig.choirName)}" onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden')" />
      <span class="logo-fallback hidden">AM</span>
    </div>
  `;
}

function buildMark() {
  return `<span class="build-mark" title="Versión de la aplicación">v${escapeHtml(appConfig.buildVersion)}</span>`;
}

function logoUrl() {
  const version = state.data?.settings?.logoUpdatedAt || "default";
  return `/logo-current?v=${encodeURIComponent(version)}`;
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
    min: minEventMonth,
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
  if (!items.length) return '<span class="person">Sin registros</span>';
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

function summaryTitle(label, items) {
  return `<strong>${escapeHtml(label)} <span>${items.length}</span></strong>`;
}

function normalizedVoice(voice) {
  return voice === "Contralto" ? "Alto" : voice || "";
}

function normalizedScoreFormat(format) {
  return ["Papel", "Digital"].includes(format) ? format : "";
}

function programMaterialMode(program = state.data?.program || {}) {
  if (program.materialMode) return program.materialMode === "server" ? "server" : "external";
  return program.materialFolder ? "server" : "external";
}

function hasPracticeMode() {
  return programMaterialMode() === "server";
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

function renderMarkdown(value) {
  const lines = String(value || "").replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = "";
  let quote = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${paragraph.map(renderMarkdownInline).join("<br />")}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = "";
  };

  const closeQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${quote.map(renderMarkdownInline).join("<br />")}</blockquote>`);
    quote = [];
  };

  const closeBlocks = () => {
    closeParagraph();
    closeList();
    closeQuote();
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeBlocks();
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeBlocks();
      const level = heading[1].length + 2;
      html.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      closeParagraph();
      closeQuote();
      const type = unordered ? "ul" : "ol";
      if (listType && listType !== type) closeList();
      if (!listType) {
        listType = type;
        html.push(`<${type}>`);
      }
      html.push(`<li>${renderMarkdownInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    const quoteLine = trimmed.match(/^>\s?(.+)$/);
    if (quoteLine) {
      closeParagraph();
      closeList();
      quote.push(quoteLine[1]);
      continue;
    }

    closeList();
    closeQuote();
    paragraph.push(line);
  }

  closeBlocks();
  return html.join("");
}

function renderMarkdownInline(value) {
  const codeSpans = [];
  let text = String(value || "").replace(/`([^`]+)`/g, (_, code) => {
    const token = `\u0000code-${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_, label, url) => {
    const href = url.replaceAll("&amp;", "&");
    return `<a href="${escapeAttr(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");

  codeSpans.forEach((code, index) => {
    text = text.replaceAll(`\u0000code-${index}\u0000`, code);
  });

  return text;
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
