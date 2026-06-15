import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dbPath = path.join(dataDir, "db.json");
const seedDbPath = path.join(__dirname, "data", "db.json");
const publicDir = path.join(__dirname, "public");

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
  mailgunApiKey: process.env.MAILGUN_API_KEY || "",
  mailgunDomain: process.env.MAILGUN_DOMAIN || "",
  mailgunBaseUrl: cleanUrl(process.env.MAILGUN_BASE_URL || "https://api.mailgun.net"),
  mailFrom: process.env.MAIL_FROM || ""
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
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

  if (req.method === "GET" && url.pathname === "/logo-current") {
    await serveLogo(res);
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

    const verification = await verifyGhostAccess(normalizedEmail);
    if (!verification.allowed) return sendJson(res, 403, { error: verification.reason });

    const db = await readDb();
    upsertProfile(db, normalizedEmail, verification.name);
    const token = randomId();
    db.magicLinks = db.magicLinks.filter((link) => link.email !== normalizedEmail);
    db.magicLinks.push({
      email: normalizedEmail,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);

    const magicUrl = `${config.baseUrl}/api/auth/consume?token=${token}`;
    const emailSent = await sendMagicLinkEmail(normalizedEmail, magicUrl);
    const mailConfigured = Boolean(config.mailgunApiKey && config.mailgunDomain && config.mailFrom);
    if (config.devAuth || !mailConfigured) {
      console.log(`Enlace mágico para ${normalizedEmail}: ${magicUrl}`);
    }
    let message = "Si el email está autorizado, recibirás un enlace de acceso.";
    if (!emailSent && mailConfigured) {
      message = "No se pudo enviar el email de acceso. Revisa la configuración de Mailgun.";
    } else if (!emailSent && config.devAuth) {
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
      return redirect(res, "/?error=expired");
    }

    db.magicLinks = db.magicLinks.filter((item) => item.tokenHash !== tokenHash);
    const sessionToken = randomId();
    db.sessions.push({
      tokenHash: hash(sessionToken),
      email: link.email,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);

    setCookie(res, "ars_session", sessionToken);
    redirect(res, "/app");
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const session = await getSession(req);
    if (session) {
      const db = await readDb();
      db.sessions = db.sessions.filter((item) => item.tokenHash !== session.tokenHash);
      await writeDb(db);
    }
    clearCookie(res, "ars_session");
    sendJson(res, 200, { ok: true });
    return;
  }

  const session = await requireSession(req, res);
  if (!session) return;

  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(session.email) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/data") {
    const db = await readDb();
    sendJson(res, 200, memberData(db, session.email));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/me/profile") {
    const body = await readJson(req);
    const db = await readDb();
    const profile = upsertProfile(db, session.email);
    profile.name = cleanText(body.name, 90);
    profile.voice = cleanText(body.voice, 40);
    await writeDb(db);
    sendJson(res, 200, { profile });
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/attendance/")) {
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const body = await readJson(req);
    const db = await readDb();
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
    await writeDb(db);
    sendJson(res, 200, memberData(db, session.email));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const db = await readDb();
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/programs") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readDb();
    if (body.active) db.programs.forEach((program) => (program.active = false));
    const program = {
      id: slugId(body.name || "programa"),
      name: cleanText(body.name, 120) || "Nuevo programa",
      description: cleanText(body.description, 500),
      works: cleanText(body.works, 5000),
      scoreFolderUrl: defaultScoreFolderUrl(),
      playlists: cleanPlaylists(body.playlists || body),
      active: Boolean(body.active ?? true),
      createdAt: new Date().toISOString()
    };
    db.programs.push(program);
    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if ((req.method === "PUT" || req.method === "POST") && url.pathname === "/api/admin/program") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readDb();
    const program = activeProgram(db);
    if (!program) return sendJson(res, 404, { error: "Programa no encontrado" });

    program.name = cleanText(body.name, 120) || program.name;
    program.description = cleanText(body.description, 500);
    program.works = cleanText(body.works, 5000);
    program.scoreFolderUrl = cleanText(body.scoreFolderUrl, 700) || defaultScoreFolderUrl();
    program.playlists = cleanPlaylists(body);
    program.updatedAt = new Date().toISOString();

    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/program/reset") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readDb();
    const current = activeProgram(db);
    const programId = current?.id || "programa-actual";

    db.programs = [
      {
        id: programId,
        name: cleanText(body.name, 120) || "Nuevo programa",
        description: cleanText(body.description, 500),
        works: "",
        scoreFolderUrl: defaultScoreFolderUrl(),
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

    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/events") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req);
    const db = await readDb();
    db.events.push({
      id: slugId(`${body.date || "evento"}-${body.title || "evento"}`),
      programId: body.programId || activeProgram(db)?.id,
      title: cleanText(body.title, 120) || "Evento",
      type: ["ensayo", "concierto", "otro"].includes(body.type) ? body.type : "ensayo",
      date: body.date || new Date().toISOString().slice(0, 10),
      time: cleanText(body.time, 40),
      location: cleanText(body.location, 160),
      notes: cleanText(body.notes, 500),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/admin/events/")) {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const body = await readJson(req);
    const db = await readDb();
    const event = db.events.find((item) => item.id === eventId);
    if (!event) return sendJson(res, 404, { error: "Evento no encontrado" });

    event.title = cleanText(body.title, 120) || event.title;
    event.type = ["ensayo", "concierto", "otro"].includes(body.type) ? body.type : event.type;
    event.date = cleanText(body.date, 16) || event.date;
    event.time = cleanText(body.time, 40);
    event.location = cleanText(body.location, 160);
    event.notes = cleanText(body.notes, 700);
    event.updatedAt = new Date().toISOString();

    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/events/")) {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const eventId = decodeURIComponent(url.pathname.split("/").pop());
    const db = await readDb();
    const exists = db.events.some((item) => item.id === eventId);
    if (!exists) return sendJson(res, 404, { error: "Evento no encontrado" });

    db.events = db.events.filter((item) => item.id !== eventId);
    db.attendance = db.attendance.filter((item) => item.eventId !== eventId);

    await writeDb(db);
    sendJson(res, 200, adminData(db));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logo") {
    if (!isAdmin(session.email)) return sendJson(res, 403, { error: "Sólo admin" });
    const body = await readJson(req, 3 * 1024 * 1024);
    const logo = parseImageDataUrl(body.image);
    if (!logo) return sendJson(res, 400, { error: "El logo debe ser JPG o PNG" });

    const db = await readDb();
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
    const db = await readDb();
    db.resources.push({
      id: slugId(`${body.type || "recurso"}-${body.title || "recurso"}`),
      programId: body.programId || activeProgram(db)?.id,
      title: cleanText(body.title, 120) || "Recurso",
      type: cleanText(body.type, 40) || "enlace",
      url: cleanText(body.url, 500),
      notes: cleanText(body.notes, 300),
      createdAt: new Date().toISOString()
    });
    await writeDb(db);
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

async function sendMagicLinkEmail(email, magicUrl) {
  if (!config.mailgunApiKey || !config.mailgunDomain || !config.mailFrom) return false;

  const form = new FormData();
  form.set("from", config.mailFrom);
  form.set("to", email);
  form.set("subject", `Access to ${config.appName}`);
  form.set(
    "html",
    `
      <div style="font-family: Georgia, serif; color: #25211e; line-height: 1.5">
        <h1 style="font-size: 24px">${escapeHtml(config.appName)}</h1>
        <p>Use this link to enter the private choir area:</p>
        <p><a href="${escapeHtml(magicUrl)}" style="color: #7f1d2d">Entrar en la zona privada</a></p>
        <p style="color: #716b65">El enlace caduca en 15 minutos.</p>
      </div>
    `
  );
  form.set(
    "text",
    `Enter ${config.appName}: ${magicUrl}\n\nThis link expires in 15 minutes.`
  );

  const response = await fetch(
    `${config.mailgunBaseUrl}/v3/${encodeURIComponent(config.mailgunDomain)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${config.mailgunApiKey}`).toString("base64")}`
      },
      body: form
    }
  );

  if (!response.ok) {
    const body = await response.text();
    console.error(`No se pudo enviar el email (${response.status}): ${body}`);
    if (!config.devAuth) throw new Error("No se pudo enviar el email de acceso");
    return false;
  }

  return true;
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

function upsertProfile(db, email, name = "") {
  let profile = db.profiles.find((item) => item.email === email);
  if (!profile) {
    profile = {
      email,
      name: name || "",
      voice: "",
      createdAt: new Date().toISOString()
    };
    db.profiles.push(profile);
  } else if (name && !profile.name) {
    profile.name = name;
  }
  return profile;
}

async function getSession(req) {
  const token = parseCookies(req.headers.cookie || "").ars_session;
  if (!token) return null;
  const db = await readDb();
  const tokenHash = hash(token);
  const session = db.sessions.find((item) => item.tokenHash === tokenHash);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  return { ...session, tokenHash };
}

async function requireSession(req, res) {
  const session = await getSession(req);
  if (!session) {
    sendJson(res, 401, { error: "No autenticado" });
    return null;
  }
  return session;
}

async function serveStatic(res, pathname) {
  const cleanPath = pathname === "/" || pathname === "/app" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) return send(res, 403, "Prohibido");
  try {
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "text/plain" });
    res.end(body);
  } catch {
    const body = await fs.readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
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
          "Cache-Control": "public, max-age=3600"
        });
        res.end(body);
        return;
      }
    }
  } catch {
    // Fall back to the bundled logo below.
  }

  const body = await fs.readFile(path.join(publicDir, "logo.jpg"));
  res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=3600" });
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
  send(res, status, JSON.stringify(payload), { "Content-Type": "application/json; charset=utf-8" });
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
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function publicUser(email) {
  return {
    email,
    role: isAdmin(email) ? "admin" : "member",
    avatarUrl: gravatarUrl(email)
  };
}

function gravatarUrl(email) {
  const digest = crypto.createHash("md5").update(String(email || "").trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${digest}?s=96&d=mp`;
}

function isAdmin(email) {
  return Boolean(email) && config.adminEmails.includes(email.toLowerCase());
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

function hash(value) {
  return crypto.createHash("sha256").update(`${config.secret}:${value}`).digest("hex");
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
