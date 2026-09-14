# Security

[Documentation index](README.md)

Hikari has no user accounts of its own. It is built to sit on a trusted network alongside the services it talks
to, like the rest of a typical self-hosted stack.

What is already in place:

- Every response carries `Content-Security-Policy` (`default-src 'self'`, no framing, no inline
  scripts, images only from AniList and the app's own bundle), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`
  and a `Permissions-Policy` denying camera, microphone and geolocation.
- The API is rate limited per address, 600 requests a minute by default (`RATE_LIMIT_PER_MINUTE`),
  and request bodies over 64 KB are refused as they arrive, not on their declared length.
- `X-Forwarded-For` is only believed when `TRUST_PROXY=true`, and then only its rightmost entry,
  which is the address your proxy actually spoke to. The values to the left of it come from the
  caller, so trusting them would let anyone invent a fresh identity per request.
- Cross-origin requests to the API are rejected, so a random page you visit cannot make Hikari
  create requests on your behalf. This is a browser protection, not authentication: `curl` and
  anything else on the network are unaffected by it, which is what the token and the login are for.
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

`HIKARI_TOKEN` makes the state-changing endpoints require `Authorization: Bearer <token>`, or
`X-Hikari-Token: <token>` if that is easier to configure. A signed-in session satisfies the same
check, so the two are alternatives rather than a pair: the token exists for the callers that cannot
hold a cookie.

**With the login off, a token turns the browser into a read-only client.** There is no session for it
to fall back on, so the settings screen can no longer save and configuration has to come from
environment variables. Either turn the login on, or leave the token unset and put authentication in
your reverse proxy.

### Generating a token

Once the login is on, **Settings → API token → Generate** mints one. It is 32 random bytes,
base64url, stored in the settings file at mode 600 like every other secret.

The value is shown **once**, at the moment it is generated. The settings screen never shows it again;
later visits see only its last four characters, the same as any other saved secret. If you lose it,
generate a new one. Note what this is and is not: the token is stored in plaintext in the settings
file, because it has to be compared against what callers send, so a copy of that file or of the
`/cache` volume is a copy of the token. "Not shown again" is about the browser, not about the disk.

- **Regenerate** replaces it immediately. Anything still sending the old value starts getting `401`,
  so update Homepage and any scripts in the same sitting.
- **Remove** deletes the override and hands the field back to `HIKARI_TOKEN`, which may still supply
  one. The screen says which of the two you end up with.
- Minting or removing one takes a **Jellyfin administrator** session, or a caller already holding the
  current token, since a script with the secret is automation you set up rather than a stranger.
- It is refused with `409` in exactly one case: the login is off **and** no token is set yet. That is
  the only state where nothing else is standing in the way — `/api/settings` is open to anyone who can
  reach the port — so without the refusal a stranger on your LAN could mint the secret and lock you
  out of your own instance. Once a token exists, holding it is proof enough to rotate or remove it
  whether the login is on or not, which is what stops turning the login off from becoming a trap.
- `POST /api/settings` refuses the `token` field, so the only way to set it is the dedicated route.
  You cannot choose the value; a generated one is uniformly random, which a chosen one rarely is.

## Requiring a login

Set `AUTH=true`, or tick **Require a Jellyfin login** under Settings, and Hikari asks for a
username and password before it shows anything. Jellyfin checks the password over
`/Users/AuthenticateByName`; Hikari only ever learns whether the answer was yes, and stores no
password of its own.

The session is a signed token in an `HttpOnly`, `SameSite=Lax` cookie, so page JavaScript cannot
read it and a link from Homepage still works. The signing key is generated on first run and kept at
`/cache/hikari-auth.json`, at mode 600. Because it is kept rather than regenerated, sessions survive
a restart; if that path is not writable Hikari still starts, but every restart signs everyone out.

| Setting | Default | What it does |
| --- | --- | --- |
| `AUTH` | `false` | Require a login |
| `AUTH_SESSION_DAYS` | 30 | How long a session lasts |
| `AUTH_ADMINS_ONLY` | `false` | Refuse non-administrator Jellyfin accounts |
| `AUTH_USERS` | empty | Comma-separated allowlist. Blank allows any Jellyfin account |

Details worth knowing:

- Failed logins are throttled to **five a minute**, counted per username and per address. Exhausting
  the address window also starts a lockout of a minute, and every further burst from that address
  doubles it up to an hour, so a patient script is slowed to a crawl. The escalation decays once a
  full penalty has passed quietly.
- The lockout deliberately applies to the address only, never to the username. Otherwise anyone
  could keep you out of your own instance just by naming you repeatedly. Spraying one account from
  many addresses is still capped at five attempts a minute.
- A wrong password and an unknown user give the same message, so the form cannot be used to discover
  who has an account.
- **Changing the settings requires a Jellyfin administrator account** once the login is on. The
  settings hold every service address, and whoever can edit them can point Jellyfin itself somewhere
  else and collect the next person's password. Everything else is open to any account that gets in.
- Sessions cannot be revoked individually, because there is nothing stored to revoke. **Sign out
  everywhere**, in the Services panel, bumps a generation counter that invalidates every token
  issued before it. It needs a valid session or the token, since otherwise it would be a one-line
  way for anyone to keep the household signed out.
- A token still works while the login is on, so scripts and the Homepage widget keep running without
  a cookie, and a signed-in session works wherever the token does. That means turning the token on no
  longer costs you the browser: you can have both. The Sonarr webhook is exempt from the login **only
  when a token is set**, because Sonarr cannot hold a cookie. With no token, the login covers it too.
- Turning this on with no reachable Jellyfin locks Hikari rather than leaving it open: every request
  answers `503` and the login screen tells you how to undo it. A control that fails open is worse
  than one that locks you out, because nothing tells you the door is ajar.
- **Locked out?** Delete or edit `auth` in `/cache/hikari-settings.json` and restart. A saved setting
  overrides the environment, so `AUTH=false` in `.env` wins nothing: the override has to go. This is
  also why you cannot turn the login off from the Settings screen once you cannot sign in, since
  `/api/settings` is behind the login as well.

This is a lock on the front door, not a hardened perimeter. It stops the household and anything
sweeping your LAN from browsing your library; it is not a reason to put the port on the internet.

## Where your AniList token comes from

If you already run the Ani-Sync Jellyfin plugin, it holds an AniList token you can reuse, so no
separate OAuth app is needed. AniList issues a single scope, so that token can write as well as
read, which is why `ANILIST_ALLOW_WRITES` defaults to `false`.
