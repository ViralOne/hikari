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

`missing` counts episodes that have aired but are not on disk, which makes it a useful alarm for
"did my downloads actually happen this week".
