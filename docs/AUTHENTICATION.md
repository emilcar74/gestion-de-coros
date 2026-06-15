# Authentication Adaptation Guide

This project currently authenticates members against Ghost Members labels because it was built for a Ghost-based choir website.

That is deliberately only one adapter, not a core requirement.

Most choirs will not use Ghost. Future maintainers, contributors, or AI agents should feel free to replace Ghost with another membership source while keeping the rest of the app unchanged.

## The Contract To Preserve

The app only needs this decision:

```text
Given an email address, decide:

- denied: this person cannot enter;
- member: this person can enter and manage only their own attendance;
- admin: this person can enter and see/manage everything.
```

Everything else is implementation detail.

Do not weaken the privacy rule:

```text
members can only read and write their own attendance;
admins can read and manage all events, repertoire, logos, and attendance.
```

## Where Authentication Lives

In the Node version, the key files are:

- `server.js`
- `.env`
- `.env.example`

The browser frontend does not know whether users come from Ghost, a text file, a CSV, SQLite, OAuth, or any other system.

The main flow is:

```text
POST /api/auth/request
  -> normalize email
  -> authorize email
  -> create magic-link token
  -> send email

GET /api/auth/consume?token=...
  -> validate token
  -> create HttpOnly session cookie

GET /api/data
  -> return member-safe data

GET /api/admin
  -> admin-only data
```

The current authorization function is named:

```js
async function verifyGhostAccess(email)
```

For a general-purpose fork, a good first refactor is to rename it to:

```js
async function authorizeEmail(email)
```

and have all auth sources implement this shape:

```js
{
  allowed: true,
  role: "member", // or "admin"
  name: "Singer Name",
  voice: "Alto"
}
```

Denied users should return:

```js
{
  allowed: false,
  reason: "Email not authorized"
}
```

## Current Ghost Adapter

The current implementation does this:

- `ADMIN_EMAILS` always grants admin access.
- Non-admin users must exist as Ghost Members.
- Non-admin users must have the configured Ghost label, for example `cantante`.
- Ghost is queried server-side through the Ghost Admin API.
- Ghost keys are never exposed to the browser.

Relevant environment variables:

```bash
GHOST_API_URL=https://your-ghost-site.example
GHOST_ADMIN_API_KEY=admin-key-id:admin-key-secret
GHOST_ACCESS_LABEL=cantante
ADMIN_EMAILS=director@example.com
```

This is useful if a choir already uses Ghost Members as its private address book. It is not required for the rest of the app.

## Recommended Alternative: CSV

For most small choirs, CSV is probably the best replacement.

Example file:

```csv
email,name,voice,role,active
director@example.com,Director,,admin,true
soprano@example.com,Ana Gomez,Soprano,member,true
alto@example.com,Bea Ruiz,Alto,member,true
former@example.com,Former Singer,Bajo,member,false
```

Suggested env var:

```bash
AUTH_PROVIDER=csv
AUTH_CSV_PATH=/opt/choir-private-area/data/users.csv
```

Suggested authorization behavior:

```text
active admin -> allowed admin
active member -> allowed member
missing email -> denied
active=false -> denied
```

Pseudo-code:

```js
async function authorizeEmail(email) {
  const normalized = normalizeEmail(email);
  const rows = await readUsersCsv(process.env.AUTH_CSV_PATH);
  const user = rows.find((row) => normalizeEmail(row.email) === normalized);

  if (!user || user.active === "false") {
    return { allowed: false, reason: "Email not authorized" };
  }

  return {
    allowed: true,
    role: user.role === "admin" ? "admin" : "member",
    name: user.name || "",
    voice: user.voice || ""
  };
}
```

If `voice` is present, update the local profile when the user logs in.

## Very Simple Alternative: Text File

For the simplest possible deployment, use one email per line.

Example:

```text
# admins
director@example.com admin

# members
soprano@example.com member Soprano
alto@example.com member Alto
tenor@example.com member Tenor
```

Suggested env var:

```bash
AUTH_PROVIDER=text
AUTH_TEXT_PATH=/opt/choir-private-area/data/allowed-users.txt
```

Rules:

- Ignore blank lines.
- Ignore lines starting with `#`.
- Split each line by whitespace.
- First token is email.
- Second token is role: `admin` or `member`.
- Third token, optional, is voice.

This is not fancy, but it is very easy for non-technical choir directors to edit.

## Database Alternative: SQLite

SQLite is a good next step if the user list should be edited through an admin UI.

Suggested table:

```sql
create table users (
  email text primary key,
  name text,
  voice text,
  role text not null check (role in ('member', 'admin')),
  active integer not null default 1,
  created_at text not null default current_timestamp
);
```

Authorization:

```text
active admin -> allowed admin
active member -> allowed member
missing/inactive -> denied
```

Suggested env vars:

```bash
AUTH_PROVIDER=sqlite
AUTH_SQLITE_PATH=/opt/choir-private-area/data/users.sqlite
```

This keeps the app self-contained and avoids external identity providers.

## External Auth Alternatives

If the choir belongs to an institution, OAuth or SSO may make sense.

Possible providers:

- Google Workspace
- Microsoft Entra ID / Microsoft 365
- Auth0
- Clerk
- Supabase Auth
- NextAuth/Auth.js in a larger rewrite

Important: OAuth login answers "who is this person?", but the app still needs authorization:

```text
is this person an admin, a choir member, or denied?
```

Do not treat "has a Google account" as enough. Keep an allowlist, domain rule, group check, database table, or role mapping.

## Magic Links Can Stay

Even if Ghost is removed, the magic-link flow can remain exactly as it is.

The app already has:

- email input;
- one-time magic-link tokens;
- token expiration;
- `HttpOnly` session cookie;
- logout;
- server-side role checks.

Replacing Ghost does not require replacing magic links. In many choir contexts, magic links are simpler than passwords.

## What An AI Agent Should Change

If asked to replace Ghost authentication, do this:

1. Add an `AUTH_PROVIDER` env var.
2. Create a generic `authorizeEmail(email)` function.
3. Move the current Ghost logic into `authorizeWithGhost(email)`.
4. Add the requested adapter, for example `authorizeWithCsv(email)`.
5. Make `/api/auth/request` call `authorizeEmail(email)` instead of `verifyGhostAccess(email)`.
6. Keep `ADMIN_EMAILS` as an optional override unless the user explicitly wants admin roles managed elsewhere.
7. Preserve magic-link sessions unless the user explicitly asks for passwords or OAuth.
8. Preserve the member/admin privacy boundaries.
9. Update `.env.example`.
10. Update this document.

Suggested dispatcher:

```js
async function authorizeEmail(email) {
  if (isAdmin(email)) return { allowed: true, role: "admin", name: email.split("@")[0] };

  switch (process.env.AUTH_PROVIDER || "ghost") {
    case "csv":
      return authorizeWithCsv(email);
    case "text":
      return authorizeWithTextFile(email);
    case "sqlite":
      return authorizeWithSqlite(email);
    case "ghost":
    default:
      return authorizeWithGhost(email);
  }
}
```

## What Must Not Change Accidentally

These checks are essential:

- `/api/data` must return only the current member's own attendance.
- `/api/attendance/:eventId` must write attendance only for the current session email.
- `/api/admin` must require admin.
- Admin mutation routes must require admin:
  - program editing;
  - event creation/editing/deletion;
  - logo upload;
  - program reset.
- Session cookies must stay `HttpOnly`.
- Secrets must stay server-side and out of Git.

## Files To Review When Adapting Auth

Minimum:

- `server.js`
- `.env.example`
- `README.md`
- `docs/AUTHENTICATION.md`

Optional if adding files:

- `auth/csv.js`
- `auth/text-file.js`
- `auth/sqlite.js`
- `data/users.example.csv`
- `data/allowed-users.example.txt`

## Suggested Public Roadmap

Good future issues for this repository:

- Add first-class CSV auth.
- Add first-class text-file auth.
- Add SQLite user management.
- Add an admin UI for singers/users.
- Split auth providers into separate adapter files.
- Add tests for member/admin access boundaries.
