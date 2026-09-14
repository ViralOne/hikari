# Security

[Documentation index](README.md)

Hikari has no user accounts. It is built to sit on a trusted network alongside the services it talks
to, like the rest of a typical self-hosted stack.

What is already in place:

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

## Where your AniList token comes from

If you already run the Ani-Sync Jellyfin plugin, it holds an AniList token you can reuse, so no
separate OAuth app is needed. AniList issues a single scope, so that token can write as well as
read, which is why `ANILIST_ALLOW_WRITES` defaults to `false`.
