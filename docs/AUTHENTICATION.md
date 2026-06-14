# Authentication Notes For Future Maintainers And AI Agents

This app currently uses Ghost as the membership source of truth.

The important application contract is not "Ghost"; the important contract is:

```text
given an email, decide whether the person is:
- denied;
- a member;
- an admin.
```

Everything else in the app can stay the same if that contract is preserved.

## Current Node Flow

In `server.js`:

- `/api/auth/request` receives an email.
- `verifyGhostAccess(email)` decides whether access is allowed.
- `isAdmin(email)` grants admin access from `ADMIN_EMAILS`.
- Non-admin access requires the configured Ghost Members label.
- A magic link is created and emailed through Mailgun.
- `/api/auth/consume` turns the magic link into an `HttpOnly` session cookie.

The frontend does not know Ghost exists.

## Current PHP Flow

In `deploy/siteground/api.php`:

- `verify_access($email, $config)` is the PHP equivalent.
- Admins come from `$config['admin_emails']`.
- Ghost Members labels authorize non-admin members.

Again, the frontend does not know Ghost exists.

## Replacing Ghost With A Text File

A simple choir might prefer:

```text
allowed-emails.txt
```

Example:

```text
director@example.com,admin
soprano@example.com,member,Soprano
alto@example.com,member,Alto
```

Implementation idea:

- Read the file server-side.
- Match normalized email.
- Return admin/member/denied.
- Optionally create/update the local profile voice part from the file.

## Replacing Ghost With CSV

Use a CSV like:

```csv
email,name,voice,role
director@example.com,Director,,admin
singer@example.com,Singer Name,Tenor,member
```

This is probably the best non-Ghost fallback for small choirs.

## Replacing Ghost With A Database

Suggested table:

```sql
create table users (
  email text primary key,
  name text,
  voice text,
  role text not null check (role in ('member', 'admin')),
  active boolean not null default true
);
```

Authorization:

```text
active admin -> admin
active member -> member
missing/inactive -> denied
```

## Replacing Magic Links

Magic links can also be swapped.

Alternatives:

- one-time numeric codes;
- password login;
- OAuth;
- SSO;
- shared rehearsal-season invite code plus email.

Keep these properties:

- server creates the session;
- session is `HttpOnly`;
- admin/member role is checked server-side;
- members can only read/write their own attendance.

## Privacy Rule

Do not weaken this:

```text
members can only read their own attendance;
admins can read all attendance.
```

In the Node version this is enforced in `/api/data`, `/api/attendance/:id`, and `/api/admin`.

In the PHP version this is enforced in `/data`, `/attendance/{id}`, and `/admin`.

## Suggested Future Refactor

Create an auth adapter interface:

```js
async function authorizeEmail(email) {
  return {
    allowed: true,
    role: "member",
    name: "Singer Name",
    voice: "Alto"
  };
}
```

Then implement adapters:

- `ghostAdapter`
- `csvAdapter`
- `textFileAdapter`
- `sqliteAdapter`
- `supabaseAdapter`

That would make the project much easier for other choirs to adopt.
