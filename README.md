# Choir Private Area

A small private web app for choirs: repertoire, calendar, absence/late notices, and an admin view for the director.

It was born for Ars Mvsica, but the goal is to make it useful for any choir director who needs a lightweight private area without running a full membership platform.

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
  - score folder;
  - Apple Music, Spotify, and YouTube playlist links.
- Manual program reset for the next concert cycle.

## Current Authentication Model

The default implementation authenticates against Ghost:

- Admins are allowed if their email is listed in `ADMIN_EMAILS`.
- Non-admin singers are allowed only if they exist as Ghost Members and have the configured label, for example `cantante`.
- Ghost is queried server-side through the Ghost Admin API.
- The Ghost Admin API key is never exposed to the browser.

This is intentionally simple: Ghost remains the membership list, while this app owns the private choir workflow.

## Other Authentication Ideas

Future maintainers or AI agents should feel free to replace the Ghost adapter.

Good alternatives:

- A plain text allowlist such as `allowed-emails.txt`.
- A CSV with `email,name,voice,role`.
- SQLite table for users.
- Google Workspace or Microsoft login.
- Supabase Auth.
- Auth0, Clerk, Lucia, NextAuth, or another common auth layer.
- A shared invite code plus email verification.

The key authorization rule should remain:

```text
admin can see everything;
member can only see and edit their own attendance.
```

See [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for implementation notes.

## Implementations Included

This repository contains two deployment paths.

### Node Version

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

### PHP / SiteGround Version

Files:

- `deploy/siteground/api.php`
- `deploy/siteground/.htaccess`
- `deploy/siteground/config.example.php`
- `deploy/siteground/public/`
- `deploy/siteground/data/db.json`

For SiteGround or similar Apache/PHP hosting:

1. Create a subdomain, for example `privado.example.com`.
2. Upload the contents of `deploy/siteground/` to the subdomain root.
3. Copy `config.example.php` to `config.php`.
4. Fill in real Ghost, Mailgun, admin, and app settings.
5. Ensure `data/db.json` is writable by PHP.
6. Visit `/api/health`; it should return `{"ok":true}`.

Do not commit `config.php`.

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

MAILGUN_API_KEY=key-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MAILGUN_DOMAIN=mg.example.com
MAILGUN_BASE_URL=https://api.mailgun.net
MAIL_FROM="Choir Private Area <access@example.com>"
```

For Mailgun EU:

```bash
MAILGUN_BASE_URL=https://api.eu.mailgun.net
```

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
  choirName: "Choir Private Area",
  loginSubtitle: "Private area for choir members. Enter with your registered email."
};
```

Replace `public/logo.jpg` with your own choir logo.

## Security Notes

- Never commit `.env`.
- Never commit `deploy/siteground/config.php`.
- Keep Ghost Admin API keys server-side only.
- Keep Mailgun keys server-side only.
- Use HTTPS in production.
- Use a long random `APP_SECRET`.

## License

MIT. See [LICENSE](LICENSE).
