# Gestion de coros

A small private web app for choirs: repertoire, calendar, absence/late notices, and an admin view for the director.

Una web privada para gestionar ensayos y otros conceptos relativos a un programa de un coro.

It was born for Ars Mvsica, but the goal is to make it useful for any choir director who needs a lightweight private area without running a full membership platform.

## Important: Authentication Is Swappable

This project currently uses Ghost Members because the first real deployment lives next to a Ghost blog.

That is not a requirement.

The app only needs to answer one question:

```text
Given an email, is this person denied, a choir member, or an admin?
```

Future maintainers, developers, or AI agents should feel free to replace Ghost with a more common source of users, such as:

- a plain text allowlist;
- a CSV file;
- SQLite;
- Supabase;
- Google or Microsoft login;
- Auth0, Clerk, or another identity provider.

The magic-link login and the choir workflow can stay the same while the membership lookup changes.

See [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) before adapting authentication. It explains the contract, the current Ghost adapter, and concrete replacement strategies.

## What It Does

- Magic-link login by email.
- Member access validated against Ghost Members labels.
- Admin access through an explicit admin email list.
- Month calendar with rehearsals, concerts, and other events.
- Singers can mark:
  - attending;
  - arriving late;
  - absent.
- Singers only see their own attendance marks.
- Admins see all absences and late arrivals, grouped by voice part.
- Editable repertoire:
  - work list;
  - protected material folder;
  - private rehearsal view with voice-specific MP3 players and embedded PDFs;
  - Apple Music, Spotify, and YouTube playlist links.
- Manual program reset for the next concert cycle.

## Current Authentication Model

The default implementation authenticates against Ghost:

- Admins are allowed if their email is listed in `ADMIN_EMAILS`.
- Non-admin singers are allowed only if they exist as Ghost Members and have the configured label, for example `cantante`.
- Ghost is queried server-side through the Ghost Admin API.
- The Ghost Admin API key is never exposed to the browser.

This is intentionally simple: Ghost remains the membership list for the original deployment, while this app owns the private choir workflow.

For most new deployments, Ghost will not be the natural choice. Start from [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) and replace the authorization lookup while preserving the privacy rules.

## Authorization Rule To Preserve

The key authorization rule should always remain:

```text
admin can see everything;
member can only see and edit their own attendance.
```

Do not weaken this when replacing Ghost.

## Implementation

Files:

- `server.js`
- `public/`
- `data/db.json`
- `render.yaml`

Run locally:

```bash
cp .env.example .env
npm run dev
```

Production-style local mode:

```bash
DEV_AUTH=false npm run dev
```

## Environment Variables For Node

```bash
PORT=3010
APP_BASE_URL=https://privado.example.com
APP_NAME="Choir Private Area"
APP_SECRET=change-this-long-random-string

GHOST_API_URL=https://your-ghost-site.example
GHOST_ADMIN_API_KEY=admin-key-id:admin-key-secret
GHOST_ACCESS_LABEL=cantante

ADMIN_EMAILS=director@example.com
DEV_AUTH=false

RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MAIL_FROM="Choir Private Area <access@example.com>"

MEDIA_DIR=/opt/ars-mvsica-privado/media
```

Resend is used for magic-link delivery because it is simple to configure and has a generous free tier for small choirs.

## Protected Materials

Program PDFs and MP3 rehearsal files can live outside `public/` and be served only to logged-in users.

Recommended production structure:

```text
/opt/ars-mvsica-privado/media/rehearsal/navidad-2026/
  Bouzignac - Ave Maria.pdf
  Bouzignac - Ave Maria - Soprano.mp3
  Bouzignac - Ave Maria - Soprano I.mp3
  Bouzignac - Ave Maria - Soprano II.mp3
  Bouzignac - Ave Maria - Alto.mp3
  Bouzignac - Ave Maria - Tenor.mp3
  Bouzignac - Ave Maria - Bajo.mp3
```

In the admin repertoire form, set:

```text
Material folder: navidad-2026
Practice works:
Bouzignac - Ave Maria
```

The app detects existing files by exact filename convention. A singer whose profile voice is `Soprano` will see every matching `Soprano`, `Soprano I`, `Soprano II`, etc. audio file for that work.

## Data Storage

The app currently stores data in JSON:

```text
data/db.json
```

This is fine for a small choir and one admin. If the app grows, good next steps are:

- SQLite;
- Postgres;
- Supabase;
- Turso/libSQL.

For the Node version, set `DATA_DIR` to store `db.json` on a persistent volume:

```bash
DATA_DIR=/var/data
```

## Branding

Frontend branding lives near the top of `public/app.js`:

```js
const appConfig = {
  choirName: "Ars Mvsica",
  loginSubtitle: "Zona privada para cantantes. Entra con tu email registrado."
};
```

Replace `public/logo.jpg` with your own choir logo.

## Security Notes

- Never commit `.env`.
- Keep Ghost Admin API keys server-side only.
- Keep Resend keys server-side only.
- Use HTTPS in production.
- Use a long random `APP_SECRET`.

## License

MIT. See [LICENSE](LICENSE).
