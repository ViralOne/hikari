# Security

[Documentation index](README.md)

Hikari has no user accounts of its own. It is built to sit on a trusted network alongside the services it talks
to, like the rest of a typical self-hosted stack.

What is already in place:

- Every response carries `Content-Security-Policy` (`default-src 'self'`, no framing, no inline
  scripts, images only from AniList), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer` and `X-Frame-Options: DENY`.
- The API is rate limited per address, 600 requests a minute by default (`RATE_LIMIT_PER_MINUTE`),
  and request bodies over 64 KB are refused.
- `X-Forwarded-For` is only believed when `TRUST_PROXY=true`, so nobody walks around the
  per-address limits by inventing a header.

- Cross-origin requests to the API are rejected, so a random page you visit cannot make Hikari
  create requests on your behalf.
- Error responses never include the body returned by an upstream service, which would otherwise
  expose internal paths and versions.
- Your API keys stay on the server. A saved secret is never sent back to the browser. The settings
  screen shows only its last four characters, and the settings file is written at mode 600.
- Only the fields Hikari knows about can be set, and every value is validated before it can reach an
  outbound request.

If the port is reachable from anywhere untrusted, do both of these:

```ini
HIKARI_TOKEN=some-long-random-string
HOST=127.0.0.1
```

`HOST=127.0.0.1` stops it listening on the network at all, which is the right setting if you reach it
through a reverse proxy on the same machine.

Sonarr's webhook cannot send custom headers, so `/api/hooks/sonarr` also accepts the token as
`?token=...`. That is the only route that does, because a token in a URL ends up in access logs.

**Settings write access is worth guarding.** Anyone who can save settings can point a service URL
at a host they control, and Hikari would then send that service's stored key there on its next
poll, without ever reading the key back. Two things limit that: changing a URL is refused unless
the matching key is supplied in the same save, and `GET /api/settings` requires the token when one
is set, because it describes every service address and the last four characters of every key.

Note the trade-off: **the built-in UI cannot send the token**, so with `HIKARI_TOKEN` set the
settings screen becomes read-only and configuration has to come from environment variables. If you
want both a protected port and browser setup, put authentication in your reverse proxy and leave
`HIKARI_TOKEN` unset.

`HIKARI_TOKEN` makes the state-changing endpoints require `Authorization: Bearer <token>`. Be aware
of the trade-off: **the built-in web UI does not send this header**, so setting it turns the browser
into a read-only client and only scripted callers can request or update anything. If you need both a
protected port and a working UI, put authentication in your reverse proxy instead and leave
`HIKARI_TOKEN` unset.

## Requiring a login

Set `AUTH=true`, or tick **Require a Jellyfin login** under Settings, and Hikari asks for a
username and password before it shows anything. Jellyfin checks the password over
`/Users/AuthenticateByName`; Hikari only ever learns whether the answer was yes, and stores no
password of its own.

The session is a signed token in an `HttpOnly`, `SameSite=Lax` cookie, so page JavaScript cannot
read it and a link from Homepage still works. The signing key is generated on first run and kept
at `/cache/hikari-auth.json` with mode 600, which is why sessions survive a restart.

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTH` | `false` | Require a login |
| `AUTH_SESSION_DAYS` | 30 | How long a session lasts |
| `AUTH_ADMINS_ONLY` | `false` | Refuse non-administrator Jellyfin accounts |
| `AUTH_USERS` | empty | Comma-separated allowlist. Blank allows any Jellyfin account |

Details worth knowing:

- Failed logins are throttled to **five a minute**, counted per username and per address, then
  locked out for a minute. Every further burst doubles the lockout up to an hour, so a patient
  script is slowed to a crawl while a real typo costs you sixty seconds. A wrong password and an
  unknown user give the same message, so the form cannot be used to discover who has an account.
- Sessions cannot be revoked individually, because there is nothing stored to revoke. **Sign out
  everywhere** bumps a generation counter that invalidates every token issued before it.
- `HIKARI_TOKEN` still works while login is on, so scripts and the Homepage widget keep running
  without a cookie. The Sonarr webhook is exempt for the same reason.
- Turning this on with no reachable Jellyfin leaves Hikari open rather than locking you out of an
  empty room.
- **Locked out?** Delete or edit `auth` in `/cache/hikari-settings.json` and restart. Environment
  variables are the fallback, so `AUTH=false` in the file wins nothing: the override has to go.

This is a lock on the front door, not a hardened perimeter. It stops the household and anything
sweeping your LAN from browsing your library; it is not a reason to put the port on the internet.

## Where your AniList token comes from

If you already run the Ani-Sync Jellyfin plugin, it holds an AniList token you can reuse, so no
separate OAuth app is needed. AniList issues a single scope, so that token can write as well as
read, which is why `ANILIST_ALLOW_WRITES` defaults to `false`.
