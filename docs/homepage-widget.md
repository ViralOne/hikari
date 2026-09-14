# Homepage widget

[Documentation index](README.md)

`GET /api/homepage` returns flat counters for a [Homepage](https://gethomepage.dev) `customapi`
widget. The whole payload is cached, so polling it does not hit your services.

```json
{
  "season": "Summer 2026",
  "airing": 30,
  "inLibrary": 9,
  "watching": 1,
  "unwatched": 8,
  "missing": 7,
  "queue": 31,
  "downloading": 0,
  "pendingRequests": 0
}
```

The URL must be reachable **from Homepage's own container**, not from your browser. On a shared
Docker network use Hikari's address on that network; `localhost` will not work. If Homepage reports
`EHOSTUNREACH`, Hikari is not running at that address yet.

Add to `services.yaml`:

```yaml
- Media:
    - Hikari:
        href: http://your-server:7997
        description: Seasonal anime discovery and requests
        icon: mdi-television-play
        widget:
          type: customapi
          url: http://your-server:7997/api/homepage
          refreshInterval: 60000
          mappings:
            - field: airing
              label: Airing
            - field: inLibrary
              label: In library
            - field: missing
              label: Missing eps
            - field: unwatched
              label: Unwatched
```

## If you have the login on

Homepage cannot hold a session cookie, so with the login switched on the widget gets
`{"error":"sign in required"}` and reports **HTTP Error**. Give it a token instead:

1. In Hikari, go to **Settings → API token** and press **Generate**. Copy the value — it is shown
   only once.
2. Add it as a header on the widget:

```yaml
        widget:
          type: customapi
          url: http://your-server:7997/api/homepage
          refreshInterval: 60000
          headers:
            X-Hikari-Token: {{HOMEPAGE_VAR_HIKARI_TOKEN}}
```

`Authorization: Bearer <token>` works just as well if you prefer it.

Putting the value straight in `services.yaml` works, but `{{HOMEPAGE_VAR_HIKARI_TOKEN}}` reads it
from Homepage's own environment instead, which keeps the secret out of the file you are most likely
to back up or paste into a forum. Set `HOMEPAGE_VAR_HIKARI_TOKEN` in Homepage's compose file.

Generating a token needs a Jellyfin administrator account and is only offered while the login is on.
With the login off nothing is required here: `/api/homepage` is a read, and reads are open. See
[Security](security.md) for why.

`missing` counts episodes that have aired but are not on disk, which makes it a useful alarm for
"did my downloads actually happen this week".
