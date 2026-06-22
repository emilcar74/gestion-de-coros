import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const auditLogPath = path.join(dataDir, "audit.log");
const seedDbPath = path.join(__dirname, "data", "db.json");
const publicDir = path.join(__dirname, "public");
const mediaDir = process.env.MEDIA_DIR || path.join(__dirname, "media");
const sessionCookieName = "ars_session_v2";
const legacySessionCookieNames = ["ars_session"];
const demoEmail = "fecorem@fecorem.es";
const demoStores = new Map();
const authMagicLinkTtlMs = 15 * 60 * 1000;
const eventNoticeMagicLinkTtlMs = 7 * 24 * 60 * 60 * 1000;

loadEnv(path.join(__dirname, ".env"));

const config = {
  port: Number(process.env.PORT || 3010),
  baseUrl: process.env.APP_BASE_URL || "http://localhost:3010",
  appName: process.env.APP_NAME || "Ars Mvsica",
  secret: process.env.APP_SECRET || "dev-secret-change-me",
  ghostUrl: cleanUrl(process.env.GHOST_API_URL || ""),
  ghostAdminKey: process.env.GHOST_ADMIN_API_KEY || "",
  accessLabel: process.env.GHOST_ACCESS_LABEL || "cantante",
  adminEmails: splitEmails(process.env.ADMIN_EMAILS || ""),
  devAuth: String(process.env.DEV_AUTH || "").toLowerCase() === "true",
  resendApiKey: process.env.RESEND_API_KEY || "",
  mailFrom: process.env.MAIL_FROM || ""
};

const authRequestMessage = "Si el email está autorizado, recibirás un enlace de acceso.";
const demoLoginMessage = "Entrando en la demo.";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

http
  .createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: "Error interno" });
    }
  })
  .listen(config.port, () => {
    console.log(`${config.appName}: ${config.baseUrl}`);
    if (config.devAuth) {
      console.log("DEV_AUTH activo: si falta Ghost, se permite login local.");
    }
  });

async function route(req, res) {
  const url = new URL(req.url, config.baseUrl);

  if (req.method === "GET" && url.pathname === "/reset-client") {
    clearClientState(res);
    redirect(res, "/?reset=1");
    return;
  }

  if (req.method === "GET" && url.pathname === "/logo-current") {
    await serveLogo(res);
    return;
  }

    if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/media/rehearsal/")) {
      await serveProtectedMedia(req, res, url);
      return;
    }

  if (url.pathname.startsWith("/api/")) {
    await routeApi(req, res, url);
    return;
  }

  await serveStatic(res, url.pathname);
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/request") {
    const { email } = await readJson(req);
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return sendJson(res, 400, { error: "Email no válido" });

    if (isDemoEmail(normalizedEmail)) {
      const sessionToken = randomId();
      const sessionId = randomId(12);
      const db = await readDb();
      db.sessions.push({
        id: sessionId,
        tokenHash: hash(sessionToken),
        email: normalizedEmail,
        demo: true,
        userAgentHash: hashUserAgent(req),
        createdIp: requestIp(req),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString()
      });
      await writeDb(db);
      demoStores.set(sessionId, buildDemoDb());
      await auditLog(req, "demo_session_created", { email: normalizedEmail, sessionId });
      setCookie(res, sessionCookieName, sessionToken);
      clearLegacySessionCookies(res);
      sendJson(res, 200, { ok: true, message: demoLoginMessage, redirectTo: "/app" });
      return;
    }

    const verification = await verifyGhostAccess(normalizedEmail);
    if (!verification.allowed) {
      await auditLog(req, "auth_request_denied", { email: normalizedEmail, reason: verification.reason });
      return sendJson(res, 200, { ok: true, message: authRequestMessage });
    }

    const token = randomId();
    const magicUrl = `${config.baseUrl}/api/auth/consume?token=${token}`;
    const mailConfigured = isEmailConfigured();

    if (!mailConfigured && !config.devAuth) {
      await auditLog(req, "auth_request_email_not_configured", { email: normalizedEmail });
      return sendJson(res, 500, {
        ok: false,
        error: "No hay proveedor de email configurado para enviar enlaces de acceso."
      });
    }

    const emailSent = await sendMagicLinkEmail(normalizedEmail, magicUrl);

    if (!emailSent && mailConfigured) {
      await auditLog(req, "auth_request_email_failed", { email: normalizedEmail });
      return sendJson(res, 502, {
        ok: false,
        error: "No se pudo enviar el email de acceso. El proveedor de email no respondió correctamente."
      });
    }

    const db = await readDb();
    upsertProfile(db, normalizedEmail, verification.name);
    db.magicLinks = db.magicLinks.filter((link) => link.email !== normalizedEmail);
    db.magicLinks.push({
      email: normalizedEmail,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + authMagicLinkTtlMs).toISOString(),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
    await auditLog(req, "auth_request_allowed", { email: normalizedEmail });

    if (config.devAuth || !mailConfigured) {
      console.log(`Enlace mágico para ${normalizedEmail}: ${magicUrl}`);
    }
    let message = authRequestMessage;
    if (!emailSent && config.devAuth) {
      message =
        "Si el email está autorizado, se ha generado un enlace de acceso. En desarrollo aparece en la terminal.";
    }

    sendJson(res, 200, {
      ok: true,
      message,
      devMagicUrl: config.devAuth && !mailConfigured ? magicUrl : undefined
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/consume") {
    const token = url.searchParams.get("token") || "";
    const db = await readDb();
    const tokenHash = hash(token);
    const link = db.magicLinks.find((item) => item.tokenHash === tokenHash);
    if (!link || new Date(link.expiresAt).getTime() < Date.now()) {
      await auditLog(req, "magic_link_rejected", { tokenHashPrefix: tokenHash.slice(0, 12) });
      return redirect(res, "/?error=expired");
    }

    db.magicLinks = db.magicLinks.filter((item) => item.tokenHash !== tokenHash);
    const sessionToken = randomId();
    const sessionId = randomId(12);
    db.sessions.push({
      id: sessionId,
      tokenHash: hash(sessionToken),
      email: link.email,
      userAgentHash: hashUserAgent(req),
      createdIp: requestIp(req),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
    await auditLog(req, "session_created", { email: link.email, sessionId });

    setCookie(res, sessionCookieName, sessionToken);
    clearLegacySessionCookies(res);
    redirect(res, "/app");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = await getSession(req);
    if (session) {
      const db = await readDb();
      db.sessions = db.sessions.filter((item) => item.tokenHash !== session.tokenHash);
      await writeDb(db);
      if (isDemoSession(session)) demoStores.delete(session.id);
    }
    clearAllSessionCookies(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET" && url.pathname === "/api/me") {
    await auditLog(req, "api_me", { email: session.email, sessionId: session.id || "" });
    sendJson(res, 200, { user: publicUser(session.email) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/data") {
    const db = await readSessionDb(session);
    await auditLog(req, "api_data", { email: session.email, sessionId: session.id || "" });
    sendJson(res, 200, memberData(db, session.email));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/materials") {
    const db = await readSessionDb(session);
    sendJson(res, 200, await materialData(db));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/me/profile") {
    const body = await readJson(req);
    const db = await readSessionDb(session);
    const profile = upsertProfile(db, session.email);
    profile.name = cleanText(body.name, 90);
    profile.voice = cleanText(body.voice, 40);
    profile.scoreFormat = cleanScoreFormat(body.scoreFormat);
    await writeSessionDb(session, db);
    sendJson(res, 200, { profile });
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/attendance/")) {
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const body = await readJson(req);
    const db = await readSessionDb(session);
    if (!db.events.some((event) => event.id === eventId)) {
      return sendJson(res, 404, { error: "Evento no encontrado" });
    }
    const status = ["coming", "late", "absent"].includes(body.status) ? body.status : "coming";
    const note = cleanText(body.note, 240);
    const existing = db.attendance.find(
      (item) => item.eventId === eventId && item.email === session.email
    );
    if (existing) {
      existing.status = status;
      existing.note = note;
      existing.updatedAt = new Date().toISOString();
    } else {
      db.attendance.push({
        id: randomId(12),
        eventId,
        email: session.email,
        status,
        note,
        updatedAt: new Date().toISOString()
      });
    }
    await writeSessionDb(session, db);
    sendJson(res, 200, memberData(db, session.email));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const db = await readSessionDb(session);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/programs") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readSessionDb(session);
    if (body.active) db.programs.forEach((program) => (program.active = false));
    const program = {
      id: slugId(body.name || "programa"),
      name: cleanText(body.name, 120) || "Nuevo programa",
      description: cleanText(body.description, 500),
      works: cleanText(body.works, 5000),
      rehearsalInstructions: cleanText(body.rehearsalInstructions, 5000),
      materialMode: materialModeFromBody(body),
      materialFolder: cleanMaterialFolder(body.materialFolder),
      practiceWorks: cleanText(body.practiceWorks, 5000),
      scoreFolderUrl: cleanText(body.scoreFolderUrl, 700),
      playlists: cleanPlaylists(body.playlists || body),
      active: Boolean(body.active ?? true),
      createdAt: new Date().toISOString()
    };
    db.programs.push(program);
    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if ((req.method === "PUT" || req.method === "POST") && url.pathname === "/api/admin/program") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readSessionDb(session);
    const program = activeProgram(db);
    if (!program) return sendJson(res, 404, { error: "Programa no encontrado" });

    program.name = cleanText(body.name, 120) || program.name;
    program.description = cleanText(body.description, 500);
    program.works = cleanText(body.works, 5000);
    program.rehearsalInstructions = cleanText(body.rehearsalInstructions, 5000);
    program.materialMode = materialModeFromBody(body);
    program.materialFolder = cleanMaterialFolder(body.materialFolder);
    program.practiceWorks = cleanText(body.practiceWorks, 5000);
    program.scoreFolderUrl = cleanText(body.scoreFolderUrl, 700);
    program.playlists = cleanPlaylists(body);
    program.updatedAt = new Date().toISOString();

    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/program/reset") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readSessionDb(session);
    const current = activeProgram(db);
    const programId = current?.id || "programa-actual";

    db.programs = [
      {
        id: programId,
        name: cleanText(body.name, 120) || "Nuevo programa",
        description: cleanText(body.description, 500),
        works: "",
        rehearsalInstructions: "",
        materialMode: materialModeFromBody(body),
        materialFolder: cleanMaterialFolder(body.materialFolder),
        practiceWorks: cleanText(body.practiceWorks, 5000),
        scoreFolderUrl: cleanText(body.scoreFolderUrl, 700),
        playlists: cleanPlaylists({}),
        active: true,
        createdAt: new Date().toISOString()
      }
    ];
    db.events = [];
    db.resources = [
      {
        id: "carpeta-partituras",
        programId,
        title: "Carpeta de partituras",
        type: "partituras",
        url: defaultScoreFolderUrl(),
        notes: "Carpeta fija de partituras.",
        createdAt: new Date().toISOString()
      }
    ];
    db.attendance = [];

    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/events") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readSessionDb(session);
    const eventRecord = {
      id: slugId(`${body.date || "evento"}-${body.title || "evento"}`),
      programId: body.programId || activeProgram(db)?.id,
      title: cleanText(body.title, 120) || "Evento",
      type: ["ensayo", "concierto", "otro"].includes(body.type) ? body.type : "ensayo",
      date: body.date || new Date().toISOString().slice(0, 10),
      time: cleanText(body.time, 40),
      location: cleanText(body.location, 160),
      notes: cleanText(body.notes, 500),
      createdAt: new Date().toISOString()
    };
    db.events.push(eventRecord);

    let notice = null;
    if (body.notifyChoir === "on" || body.notifyChoir === true) {
      notice = await prepareEventNotice(db, eventRecord, session);
    }

    await writeSessionDb(session, db);

    if (notice?.recipients?.length) {
      notice = await sendEventNotice(eventRecord, notice);
      await auditLog(req, "event_notice_sent", {
        eventId: eventRecord.id,
        sent: notice.sent,
        failed: notice.failed
      });
    }

    sendJson(res, 200, { ...adminData(db), notice });
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/events/")) {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const body = await readJson(req);
    const db = await readSessionDb(session);
    const event = db.events.find((item) => item.id === eventId);
    if (!event) return sendJson(res, 404, { error: "Evento no encontrado" });

    event.title = cleanText(body.title, 120) || event.title;
    event.type = ["ensayo", "concierto", "otro"].includes(body.type) ? body.type : event.type;
    event.date = cleanText(body.date, 16) || event.date;
    event.time = cleanText(body.time, 40);
    event.location = cleanText(body.location, 160);
    event.notes = cleanText(body.notes, 700);
    event.updatedAt = new Date().toISOString();

    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/events/")) {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const db = await readSessionDb(session);
    const exists = db.events.some((item) => item.id === eventId);
    if (!exists) return sendJson(res, 404, { error: "Evento no encontrado" });

    db.events = db.events.filter((item) => item.id !== eventId);
    db.attendance = db.attendance.filter((item) => item.eventId !== eventId);

    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/profiles/")) {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const email = normalizeEmail(decodeURIComponent(url.pathname.split("/").pop()));
    if (!email) return sendJson(res, 400, { error: "Email no válido" });
    if (email === session.email) return sendJson(res, 400, { error: "No puedes eliminar tu propio perfil" });

    const db = await readSessionDb(session);
    const exists = db.profiles.some((profile) => profile.email === email);
    if (!exists) return sendJson(res, 404, { error: "Perfil no encontrado" });

    db.profiles = db.profiles.filter((profile) => profile.email !== email);
    db.attendance = db.attendance.filter((item) => item.email !== email);
    db.sessions = (db.sessions || []).filter((item) => item.email !== email);
    db.magicLinks = (db.magicLinks || []).filter((item) => item.email !== email);

    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logo") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req, 3 * 1024 * 1024);
    const logo = parseImageDataUrl(body.image);
    if (!logo) return sendJson(res, 400, { error: "El logo debe ser JPG o PNG" });

    const db = await readSessionDb(session);
    if (isDemoSession(session)) {
      db.settings = {
        ...(db.settings || {}),
        logoUpdatedAt: new Date().toISOString()
      };
      await writeSessionDb(session, db);
      sendJson(res, 200, adminData(db));
      return;
    }

    const fileName = `logo-current.${logo.ext}`;
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, fileName), logo.buffer);
    db.settings = {
      ...(db.settings || {}),
      logoFile: fileName,
      logoMime: logo.mime,
      logoUpdatedAt: new Date().toISOString()
    };

    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/resources") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readSessionDb(session);
    db.resources.push({
      id: slugId(`${body.type || "recurso"}-${body.title || "recurso"}`),
      programId: body.programId || activeProgram(db)?.id,
      title: cleanText(body.title, 120) || "Recurso",
      type: cleanText(body.type, 40) || "enlace",
      url: cleanText(body.url, 500),
      notes: cleanText(body.notes, 300),
      createdAt: new Date().toISOString()
    });
    await writeSessionDb(session, db);
    sendJson(res, 200, adminData(db));
    return;
  }

  sendJson(res, 404, { error: "Ruta no encontrada" });
}

async function verifyGhostAccess(email) {
  if (isAdmin(email)) return { allowed: true, name: email.split("@")[0] };

  if (!config.ghostUrl || !config.ghostAdminKey) {
    if (config.devAuth) return { allowed: true, name: email.split("@")[0] };
    return { allowed: false, reason: "Ghost no está configurado" };
  }

  const jwt = createGhostAdminJwt(config.ghostAdminKey);
  const filter = encodeURIComponent(`email:'${email.replaceAll("'", "\\'")}'`);
  const url = `${config.ghostUrl}/ghost/api/admin/members/?filter=${filter}&include=labels&limit=1`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Ghost ${jwt}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    console.error(`Ghost respondió ${response.status}: ${await response.text()}`);
    return { allowed: false, reason: "No se pudo validar el acceso con Ghost" };
  }

  const payload = await response.json();
  const member = payload.members?.[0];
  if (!member) return { allowed: false, reason: "Email no encontrado en Ghost" };

  const expected = config.accessLabel.toLowerCase();
  const hasLabel = (member.labels || []).some((label) =>
    [label.name, label.slug].filter(Boolean).map((value) => value.toLowerCase()).includes(expected)
  );
  if (!hasLabel) return { allowed: false, reason: `Falta la etiqueta ${config.accessLabel}` };

  return { allowed: true, name: member.name || "" };
}

async function prepareEventNotice(db, eventRecord, session) {
  if (isDemoSession(session)) {
    return { sent: 0, failed: 0, skipped: true, message: "La demo no envía avisos reales." };
  }

  if (!isEmailConfigured()) {
    return { sent: 0, failed: 0, error: "No hay proveedor de email configurado." };
  }

  let members;
  try {
    members = await ghostChoirMembers();
  } catch (error) {
    console.error(`No se pudo preparar el aviso del evento: ${error.message}`);
    return { sent: 0, failed: 0, error: "No se pudo obtener el listado del coro desde Ghost." };
  }

  const recipients = members
    .map((member) => ({ ...member, email: normalizeEmail(member.email) }))
    .filter((member) => member.email && !isAdmin(member.email));

  recipients.forEach((member) => {
    const token = randomId();
    member.magicUrl = `${config.baseUrl}/api/auth/consume?token=${token}`;
    db.magicLinks.push({
      email: member.email,
      tokenHash: hash(token),
      purpose: "event_notice",
      eventId: eventRecord.id,
      expiresAt: new Date(Date.now() + eventNoticeMagicLinkTtlMs).toISOString(),
      createdAt: new Date().toISOString()
    });
  });

  return { sent: 0, failed: 0, recipients };
}

async function ghostChoirMembers() {
  if (!config.ghostUrl || !config.ghostAdminKey) {
    if (config.devAuth) return [];
    throw new Error("Ghost no está configurado");
  }

  const jwt = createGhostAdminJwt(config.ghostAdminKey);
  const members = [];
  let page = 1;
  let pages = 1;

  do {
    const url = `${config.ghostUrl}/ghost/api/admin/members/?include=labels&limit=100&page=${page}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Ghost ${jwt}`,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Ghost respondió ${response.status}: ${await response.text()}`);
    }

    const payload = await response.json();
    members.push(...(payload.members || []));
    pages = payload.meta?.pagination?.pages || page;
    page += 1;
  } while (page <= pages);

  const expected = config.accessLabel.toLowerCase();
  const seen = new Set();
  return members
    .filter((member) =>
      (member.labels || []).some((label) =>
        [label.name, label.slug].filter(Boolean).map((value) => value.toLowerCase()).includes(expected)
      )
    )
    .map((member) => ({ email: member.email || "", name: member.name || "" }))
    .filter((member) => {
      const email = normalizeEmail(member.email);
      if (!email || seen.has(email)) return false;
      seen.add(email);
      member.email = email;
      return true;
    });
}

async function sendEventNotice(eventRecord, notice) {
  let sent = 0;
  let failed = 0;

  for (const recipient of notice.recipients) {
    const ok = await sendEventNoticeEmail(recipient.email, eventRecord, recipient.magicUrl);
    if (ok) sent += 1;
    else failed += 1;
  }

  return { sent, failed };
}

async function sendMagicLinkEmail(email, magicUrl) {
  return sendMagicLinkWithResend(email, magicUrl);
}

function magicLinkEmail(email, magicUrl) {
  return {
    from: config.mailFrom,
    to: email,
    subject: `Acceso a ${config.appName}`,
    html: `
      <div style="font-family: Georgia, serif; color: #25211e; line-height: 1.5">
        <h1 style="font-size: 24px">${escapeHtml(config.appName)}</h1>
        <p>Usa este enlace para entrar en la zona privada del coro:</p>
        <p><a href="${escapeHtml(magicUrl)}" style="color: #7f1d2d">Entrar en la zona privada</a></p>
        <p style="color: #716b65">El enlace caduca en 15 minutos.</p>
      </div>
    `,
    text: `Entra en ${config.appName}: ${magicUrl}\n\nEste enlace caduca en 15 minutos.`
  };
}

function eventNoticeEmail(email, eventRecord, magicUrl) {
  const title = eventRecord.title || "Nuevo evento";
  const when = [formatEventDate(eventRecord.date), eventRecord.time].filter(Boolean).join(" · ");
  const where = eventRecord.location || "Lugar pendiente";
  const notes = eventRecord.notes ? `<p><strong>Notas:</strong> ${escapeHtml(eventRecord.notes)}</p>` : "";
  return {
    from: config.mailFrom,
    to: email,
    subject: `Nuevo evento en ${config.appName}: ${title}`,
    html: `
      <div style="font-family: Georgia, serif; color: #25211e; line-height: 1.5">
        <h1 style="font-size: 24px">${escapeHtml(config.appName)}</h1>
        <p>Se ha añadido un nuevo evento al calendario del coro.</p>
        <p>
          <strong>${escapeHtml(title)}</strong><br />
          ${escapeHtml(when)}<br />
          ${escapeHtml(where)}
        </p>
        ${notes}
        <p>Entra en la zona privada para confirmar si asistirás, llegarás tarde o no podrás asistir.</p>
        <p><a href="${escapeHtml(magicUrl)}" style="color: #7f1d2d">Entrar y responder</a></p>
        <p style="color: #716b65">Este enlace caduca en 7 días.</p>
      </div>
    `,
    text: `Nuevo evento en ${config.appName}\n\n${title}\n${when}\n${where}\n\nEntra en la zona privada para confirmar asistencia: ${magicUrl}\n\nEste enlace caduca en 7 días.`
  };
}

async function sendEventNoticeEmail(email, eventRecord, magicUrl) {
  return sendEmailWithResend(eventNoticeEmail(email, eventRecord, magicUrl));
}

async function sendMagicLinkWithResend(email, magicUrl) {
  if (!config.resendApiKey || !config.mailFrom) return false;

  return sendEmailWithResend(magicLinkEmail(email, magicUrl));
}

async function sendEmailWithResend(message) {
  if (!config.resendApiKey || !config.mailFrom) return false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(message)
      });
    } catch (error) {
      console.error(`No se pudo conectar con Resend, intento ${attempt}/3: ${error.message}`);
      if (attempt < 3) await delay(600 * attempt);
      continue;
    }

    if (response.ok) return true;

    const body = await response.text();
    console.error(`No se pudo enviar el email con Resend, intento ${attempt}/3 (${response.status}): ${body}`);
    if (response.status < 500) return false;
    if (attempt < 3) await delay(600 * attempt);
  }

  return false;
}

function formatEventDate(date) {
  if (!date) return "";
  return new Intl.DateTimeFormat("es", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date(`${date}T12:00:00`));
}

function isEmailConfigured() {
  return Boolean(config.resendApiKey && config.mailFrom);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createGhostAdminJwt(adminKey) {
  const [kid, secretHex] = adminKey.split(":");
  if (!kid || !secretHex) throw new Error("GHOST_ADMIN_API_KEY debe tener formato id:secret");

  const header = base64urlJson({ alg: "HS256", typ: "JWT", kid });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlJson({ iat: now, exp: now + 5 * 60, aud: "/admin/" });
  const body = `${header}.${payload}`;
  const signature = crypto
    .createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function memberData(db, email) {
  const program = activeProgram(db);
  const events = db.events
    .filter((event) => event.programId === program?.id)
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  return {
    user: publicUser(email),
    program,
    events,
    resources: db.resources.filter((resource) => resource.programId === program?.id),
    settings: publicSettings(db),
    profile: db.profiles.find((profile) => profile.email === email) || null,
    attendance: db.attendance.filter((item) => item.email === email)
  };
}

function adminData(db) {
  const data = memberData(db, "");
  return {
    ...data,
    programs: db.programs,
    profiles: db.profiles.sort((a, b) => a.email.localeCompare(b.email)),
    allAttendance: db.attendance
  };
}

async function materialData(db) {
  const program = activeProgram(db);
  const mode = materialMode(program);
  const folder = cleanMaterialFolder(program?.materialFolder || "");
  const practiceWorks = mode === "server" ? practiceWorkEntries(program) : [];
  const files = mode === "server" && folder ? await listMaterialFiles(folder) : [];
  const byMatchName = new Map(files.map((file) => [materialMatchKey(file.name), file]));
  const works = practiceWorks.map((work) => {
    const pdfKey = materialMatchKey(`${work.fileBase}.pdf`);
    const prefixKey = materialMatchKey(`${work.fileBase} - `);
    return {
      title: work.title,
      fileBase: work.fileBase,
      pdf: byMatchName.get(pdfKey) || null,
      audios: files
        .filter((file) => file.type === "audio" && materialMatchKey(file.name).startsWith(prefixKey))
        .map((file) => ({ ...file, voice: audioVoiceFromName(file.name, work.fileBase) }))
        .filter((file) => file.voice)
        .sort((a, b) => a.voice.localeCompare(b.voice))
    };
  });

  return {
    mode,
    folder,
    files,
    works
  };
}

function practiceWorkEntries(program) {
  return String(program?.practiceWorks || "")
    .split("\n")
    .map((line) => cleanText(line, 180))
    .map((line) => {
      const [titlePart, fileBasePart] = line.split("|").map((part) => cleanText(part, 180).trim());
      const title = titlePart || fileBasePart || "";
      const fileBase = fileBasePart || title;
      return title && fileBase ? { title, fileBase } : null;
    })
    .filter(Boolean);
}

function audioVoiceFromName(filename, fileBase) {
  const withoutExtension = filename.replace(/\.mp3$/i, "");
  const exactPrefix = `${fileBase} - `;
  if (withoutExtension.startsWith(exactPrefix)) return withoutExtension.slice(exactPrefix.length).trim();

  const normalizedPrefix = materialMatchKey(exactPrefix);
  const normalizedName = materialMatchKey(withoutExtension);
  if (!normalizedName.startsWith(normalizedPrefix)) return "";

  const suffixLength = normalizedName.length - normalizedPrefix.length;
  return withoutExtension.slice(-suffixLength).trim();
}

async function listMaterialFiles(folder) {
  const folderPath = materialFolderPath(folder);
  let entries = [];
  try {
    entries = await fs.readdir(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => materialFile(folder, entry.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function materialFile(folder, name) {
  if (!isSafeMaterialFilename(name)) return null;
  const ext = path.extname(name).toLowerCase();
  if (![".pdf", ".mp3"].includes(ext)) return null;
  return {
    name,
    type: ext === ".pdf" ? "pdf" : "audio",
    url: `/media/rehearsal/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`
  };
}

function upsertProfile(db, email, name = "") {
  let profile = db.profiles.find((item) => item.email === email);
  if (!profile) {
    profile = {
      email,
      name: name || "",
      voice: "",
      scoreFormat: "",
      createdAt: new Date().toISOString()
    };
    db.profiles.push(profile);
  } else if (name && !profile.name) {
    profile.name = name;
  }
  return profile;
}

function cleanScoreFormat(value) {
  const format = cleanText(value, 20);
  return ["Papel", "Digital"].includes(format) ? format : "";
}

async function getSession(req) {
  const token = parseCookies(req.headers.cookie || "")[sessionCookieName];
  if (!token) return null;
  const db = await readDb();
  const tokenHash = hash(token);
  const session = db.sessions.find((item) => item.tokenHash === tokenHash);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  if (session.userAgentHash && session.userAgentHash !== hashUserAgent(req)) return null;
  return { ...session, tokenHash };
}

async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    const names = sessionCookieNamesInRequest(req);
    if (names.length) await auditLog(req, "session_rejected", { cookieNames: names });
    sendJson(res, 401, { error: "No autenticado" });
    return null;
  }
  return session;
}

async function serveProtectedMedia(req, res, url) {
  const session = await getSession(req);
  if (!session) return redirect(res, "/");

  const parts = url.pathname.split("/").filter(Boolean);
  const folder = cleanMaterialFolder(decodeURIComponent(parts[2] || ""));
  const filename = decodeURIComponent(parts.slice(3).join("/") || "");
  if (!folder || !isSafeMaterialFilename(filename)) {
    return send(res, 404, "No encontrado", { "Cache-Control": "no-store" });
  }

  const filePath = path.normalize(path.join(materialFolderPath(folder), filename));
  if (!filePath.startsWith(materialFolderPath(folder))) {
    return send(res, 403, "Prohibido", { "Cache-Control": "no-store" });
  }

  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return send(res, 404, "No encontrado", { "Cache-Control": "no-store" });
  }
  if (!stat.isFile()) return send(res, 404, "No encontrado", { "Cache-Control": "no-store" });

  const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
      return res.end();
    }
    res.writeHead(206, {
      "Content-Type": contentType,
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store"
    });
    if (req.method === "HEAD") return res.end();
    return fsSync.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store"
  });
  if (req.method === "HEAD") return res.end();
  fsSync.createReadStream(filePath).pipe(res);
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" || pathname === "/app" ? "/index.html" : pathname;
  if (isBlockedStaticPath(cleanPath)) return send(res, 404, "No encontrado", { "Cache-Control": "no-store" });
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) return send(res, 403, "Prohibido");
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
  }
}

async function serveLogo(res) {
  try {
    const db = await readDb();
    if (db.settings?.logoFile) {
      const logoPath = path.normalize(path.join(dataDir, db.settings.logoFile));
      if (logoPath.startsWith(dataDir)) {
        const body = await fs.readFile(logoPath);
        res.writeHead(200, {
          "Content-Type": db.settings.logoMime || mimeTypes[path.extname(logoPath)] || "image/jpeg",
          "Cache-Control": "no-store"
        });
        res.end(body);
        return;
      }
    }
  } catch {
    // Fall back to the bundled logo below.
  }

  const body = await fs.readFile(path.join(publicDir, "logo.jpg"));
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-store" });
  res.end(body);
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await fs.readFile(dbPath, "utf8"));
}

async function writeDb(db) {
  await ensureDb();
  await fs.writeFile(dbPath, `${JSON.stringify(db, null, 2)}\n`);
}

async function readSessionDb(session) {
  if (isDemoSession(session)) return demoDbForSession(session);
  return readDb();
}

async function writeSessionDb(session, db) {
  if (isDemoSession(session)) {
    demoStores.set(session.id, db);
    return;
  }
  await writeDb(db);
}

function demoDbForSession(session) {
  if (!demoStores.has(session.id)) demoStores.set(session.id, buildDemoDb());
  return demoStores.get(session.id);
}

function buildDemoDb() {
  const programId = "demo-programa-otono";
  const profiles = [
    { email: demoEmail, name: "Demo Fecorem", voice: "", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "ana.soprano@example.com", name: "Ana Valverde", voice: "Soprano", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "ines.soprano@example.com", name: "Ines Duarte", voice: "Soprano", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "marta.soprano@example.com", name: "Marta Alcazar", voice: "Soprano", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "clara.soprano@example.com", name: "Clara Roig", voice: "Soprano", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "lucia.alto@example.com", name: "Lucia Serrano", voice: "Alto", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "marina.alto@example.com", name: "Marina Rios", voice: "Alto", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "elena.alto@example.com", name: "Elena Casas", voice: "Alto", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "beatriz.alto@example.com", name: "Beatriz Lozano", voice: "Alto", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "pablo.tenor@example.com", name: "Pablo Navas", voice: "Tenor", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "hector.tenor@example.com", name: "Hector Molina", voice: "Tenor", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "alvaro.tenor@example.com", name: "Alvaro Sanz", voice: "Tenor", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "sergio.tenor@example.com", name: "Sergio Ferrer", voice: "Tenor", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "carlos.bajo@example.com", name: "Carlos Beltran", voice: "Bajo", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "ramon.bajo@example.com", name: "Ramon Vidal", voice: "Bajo", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "jorge.bajo@example.com", name: "Jorge Mena", voice: "Bajo", createdAt: "2026-06-15T00:00:00.000Z" },
    { email: "manuel.bajo@example.com", name: "Manuel Pardo", voice: "Bajo", createdAt: "2026-06-15T00:00:00.000Z" }
  ];
  profiles.forEach((profile, index) => {
    profile.scoreFormat = profile.email === demoEmail ? "" : index % 3 === 0 ? "Papel" : "Digital";
  });
  const events = [
    demoEvent(programId, "ensayo-2026-09-03", "Ensayo de lectura", "ensayo", "2026-09-03", "19:30", "Centro cultural", "Lectura general del programa."),
    demoEvent(programId, "ensayo-2026-09-10", "Ensayo seccional", "ensayo", "2026-09-10", "19:30", "Aula de musica", "Trabajo por cuerdas."),
    demoEvent(programId, "ensayo-2026-09-17", "Ensayo tutti", "ensayo", "2026-09-17", "19:30", "Centro cultural", "Obras 1 y 2."),
    demoEvent(programId, "ensayo-2026-09-24", "Ensayo con piano", "ensayo", "2026-09-24", "19:30", "Auditorio municipal", "Primer pase con acompanamiento."),
    demoEvent(programId, "ensayo-2026-10-01", "Ensayo", "ensayo", "2026-10-01", "19:30", "Centro cultural", "Afinacion y texto."),
    demoEvent(programId, "ensayo-2026-10-08", "Ensayo", "ensayo", "2026-10-08", "19:30", "Centro cultural", "Bloque central del programa."),
    demoEvent(programId, "concierto-2026-10-16", "Concierto didactico", "concierto", "2026-10-16", "20:00", "Teatro de la Villa", "Programa reducido."),
    demoEvent(programId, "ensayo-2026-10-22", "Ensayo", "ensayo", "2026-10-22", "19:30", "Centro cultural", "Repaso del concierto y nuevas obras."),
    demoEvent(programId, "ensayo-2026-11-05", "Ensayo", "ensayo", "2026-11-05", "19:30", "Centro cultural", "Trabajo de dinamicas."),
    demoEvent(programId, "ensayo-2026-11-12", "Ensayo con solistas", "ensayo", "2026-11-12", "19:30", "Auditorio municipal", "Entradas y transiciones."),
    demoEvent(programId, "concierto-2026-11-21", "Encuentro coral", "concierto", "2026-11-21", "19:00", "Iglesia de San Miguel", "Con otros dos coros invitados."),
    demoEvent(programId, "ensayo-2026-11-26", "Ensayo", "ensayo", "2026-11-26", "19:30", "Centro cultural", "Ajustes tras el encuentro."),
    demoEvent(programId, "ensayo-2026-12-03", "Ensayo general", "ensayo", "2026-12-03", "19:30", "Auditorio municipal", "Programa completo sin cortes."),
    demoEvent(programId, "ensayo-2026-12-10", "Ensayo general", "ensayo", "2026-12-10", "19:30", "Auditorio municipal", "Orden definitivo."),
    demoEvent(programId, "concierto-2026-12-13", "Concierto de cierre", "concierto", "2026-12-13", "20:00", "Auditorio municipal", "Convocatoria a las 18:45."),
    demoEvent(programId, "concierto-2026-12-20", "Concierto benefico", "concierto", "2026-12-20", "19:30", "Parroquia de Santa Cecilia", "Ultimo concierto del ciclo.")
  ];
  return {
    programs: [
      {
        id: programId,
        name: "Demo: Cantares de invierno",
        description: "Programa ficticio para mostrar la gestion de repertorio, calendario y avisos de asistencia.",
        works: [
          "Aurora de los caminos - M. Ledesma",
          "Tres nanas del agua - A. Fictoria",
          "Canticum breve - L. Moreno",
          "Romance del aire claro - Popular, arr. S. Vidal",
          "Lux serena - E. Navarro"
        ].join("\n"),
        rehearsalInstructions: [
          "Antes del proximo ensayo: repasar texto de Aurora de los caminos y marcar respiraciones.",
          "Sopranos y altos: revisar compases 32-48 de Tres nanas del agua.",
          "Tenores y bajos: llevar preparado el ostinato de Lux serena a tempo lento.",
          "Escuchar la lista de YouTube al menos una vez siguiendo la partitura."
        ].join("\n"),
        materialMode: "server",
        materialFolder: "demo-cantares-invierno",
        practiceWorks: [
          "Aurora de los caminos | M. Ledesma - Aurora de los caminos",
          "Tres nanas del agua | A. Fictoria - Tres nanas del agua",
          "Lux serena | E. Navarro - Lux serena"
        ].join("\n"),
        scoreFolderUrl: "https://example.com/demo/partituras",
        playlists: {
          appleMusic: "https://music.apple.com/",
          spotify: "https://open.spotify.com/",
          youtube: "https://www.youtube.com/"
        },
        active: true,
        createdAt: "2026-06-15T00:00:00.000Z"
      }
    ],
    events,
    resources: [
      {
        id: "demo-carpeta-partituras",
        programId,
        title: "Carpeta de partituras demo",
        type: "partituras",
        url: "https://example.com/demo/partituras",
        notes: "En una instalacion real este enlace apunta a Drive, Dropbox u otra carpeta compartida.",
        createdAt: "2026-06-15T00:00:00.000Z"
      }
    ],
    profiles,
    attendance: demoAttendance(events, profiles),
    settings: {},
    magicLinks: [],
    sessions: []
  };
}

function demoEvent(programId, id, title, type, date, time, location, notes) {
  return { id, programId, title, type, date, time, location, notes, createdAt: "2026-06-15T00:00:00.000Z" };
}

function demoAttendance(events, profiles) {
  const singers = profiles.filter((profile) => profile.email !== demoEmail);
  const notes = {
    late: [
      "Salgo tarde del trabajo.",
      "Llegare unos 20 minutos tarde.",
      "Clase hasta las 19:45.",
      "Llego desde otra reunion.",
      "Avisare si puedo llegar antes."
    ],
    absent: [
      "Viaje familiar.",
      "Compromiso profesional.",
      "No estare en la ciudad.",
      "Guardia medica.",
      "Baja temporal."
    ]
  };
  const rows = [];
  events.forEach((event, eventIndex) => {
    singers.forEach((profile, singerIndex) => {
      const mark = (eventIndex * 5 + singerIndex * 3) % 13;
      if (mark === 0 || mark === 6 || (eventIndex > 11 && mark === 10)) return;
      const status =
        mark === 2 || mark === 9
          ? "late"
          : mark === 4 || (event.type === "concierto" && mark === 8)
            ? "absent"
            : "coming";
      const note =
        status === "late"
          ? notes.late[(eventIndex + singerIndex) % notes.late.length]
          : status === "absent"
            ? notes.absent[(eventIndex + singerIndex) % notes.absent.length]
            : "";
      rows.push({
        id: `demo-asistencia-${rows.length + 1}`,
        eventId: event.id,
        email: profile.email,
        status,
        note,
        updatedAt: "2026-06-15T00:00:00.000Z"
      });
    });
  });
  return rows;
}

async function ensureDb() {
  try {
    await fs.access(dbPath);
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    await fs.copyFile(seedDbPath, dbPath);
  }
}

async function readJson(req, maxBytes = 1024 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Petición demasiado grande");
  }
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Cookie"
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function setCookie(res, name, value) {
  const secure = config.baseUrl.startsWith("https://") || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}${secure ? "; Secure" : ""}`
  );
}

function clearCookie(res, name) {
  appendCookieHeader(res, `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  appendCookieHeader(res, `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`);
}

function clearClientState(res) {
  res.setHeader("Clear-Site-Data", '"cache", "cookies", "storage"');
  clearAllSessionCookies(res);
}

function clearAllSessionCookies(res) {
  clearCookie(res, sessionCookieName);
  clearLegacySessionCookies(res);
}

function clearLegacySessionCookies(res) {
  legacySessionCookieNames.forEach((name) => clearCookie(res, name));
}

function sessionCookieNamesInRequest(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return [sessionCookieName, ...legacySessionCookieNames].filter((name) => cookies[name]);
}

function appendCookieHeader(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) {
    res.setHeader("Set-Cookie", cookie);
  } else if (Array.isArray(current)) {
    res.setHeader("Set-Cookie", [...current, cookie]);
  } else {
    res.setHeader("Set-Cookie", [current, cookie]);
  }
}

function publicUser(email) {
  return {
    email,
    role: isAdmin(email) ? "admin" : "member",
    demo: isDemoEmail(email),
    avatarUrl: gravatarUrl(email)
  };
}

function gravatarUrl(email) {
  const digest = crypto.createHash("md5").update(String(email || "").trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${digest}?s=96&d=mp`;
}

function isAdmin(email) {
  return Boolean(email) && (isDemoEmail(email) || config.adminEmails.includes(email.toLowerCase()));
}

function isDemoEmail(email) {
  return normalizeEmail(email) === demoEmail;
}

function isDemoSession(session) {
  return Boolean(session?.demo && isDemoEmail(session.email));
}

function activeProgram(db) {
  return db.programs.find((program) => program.active) || db.programs[0] || null;
}

function cleanPlaylists(value) {
  return {
    appleMusic: cleanText(value.appleMusic, 700),
    spotify: cleanText(value.spotify, 700),
    youtube: cleanText(value.youtube, 700)
  };
}

function cleanMaterialFolder(value) {
  const folder = cleanText(value, 80).trim();
  return /^[A-Za-z0-9._-]+$/.test(folder) ? folder : "";
}

function cleanMaterialMode(value) {
  return value === "server" ? "server" : "external";
}

function materialModeFromBody(body) {
  if (body.materialMode) return cleanMaterialMode(body.materialMode);
  return body.materialFolder ? "server" : "external";
}

function materialMode(program) {
  if (program?.materialMode) return cleanMaterialMode(program.materialMode);
  return program?.materialFolder ? "server" : "external";
}

function materialFolderPath(folder) {
  return path.normalize(path.join(mediaDir, "rehearsal", folder));
}

function isSafeMaterialFilename(name) {
  return Boolean(name && !name.includes("/") && !name.includes("\\") && !name.includes(".."));
}

function publicSettings(db) {
  return {
    logoUpdatedAt: db.settings?.logoUpdatedAt || ""
  };
}

function parseImageDataUrl(value) {
  const match = String(value || "").match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;

  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 2 * 1024 * 1024) return null;

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;

  if (mime === "image/jpeg" && isJpeg) return { buffer, mime, ext: "jpg" };
  if (mime === "image/png" && isPng) return { buffer, mime, ext: "png" };
  return null;
}

function defaultScoreFolderUrl() {
  return "https://example.com/scores";
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
  );
}

function isBlockedStaticPath(pathname) {
  return (
    pathname.startsWith("/.") ||
    pathname.includes("/.") ||
    ["/env", "/secrets.env"].includes(pathname)
  );
}

function splitEmails(value) {
  return value
    .split(",")
    .map((item) => normalizeEmail(item))
    .filter(Boolean);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function slugId(value) {
  const base = String(value || "item")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  return `${base || "item"}-${randomId(4)}`;
}

function materialMatchKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function hash(value) {
  return crypto.createHash("sha256").update(`${config.secret}:${value}`).digest("hex");
}

function hashUserAgent(req) {
  return crypto
    .createHash("sha256")
    .update(String(req.headers["user-agent"] || ""))
    .digest("hex");
}

function requestIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
}

async function auditLog(req, event, details = {}) {
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ip: requestIp(req),
      uaHash: hashUserAgent(req).slice(0, 16),
      ...details
    });
    await fs.appendFile(auditLogPath, `${line}\n`);
  } catch (error) {
    console.error("No se pudo escribir audit.log", error);
  }
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function cleanUrl(value) {
  return String(value || "").replace(/\/$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadEnv(filePath) {
  if (!fsSync.existsSync(filePath)) return;
  const content = fsSync.readFileSync(filePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = parseEnvValue(rest.join("="));
  }
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
