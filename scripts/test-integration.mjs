import { startFakes } from "./lib/fakes.mjs";
import { startHikari } from "./lib/harness.mjs";

// The whole server against fake upstreams: discover, detail, request, list. The unit tests pin
// each pure function on its own; this pins that the routes wire them together the way the frontend
// expects, and that what goes out to Jellyseerr and AniList is what was meant. No network, no
// services, no fixtures. Run: npm run test:integration
//
// Every upstream response comes from scripts/lib/fakes.mjs, so a failure here is either Hikari or
// the fake, never a service that happened to be down.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const readJson = async res => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
};

const fakes = await startFakes();
let hikari = await startHikari({ fakes });

// Keep the log of every server instance started, so a failure prints all of them.
const logs = [hikari.logs];

try {
  // -------------------------------------------------------------------------------------------
  console.log("health");

  const health = await readJson(await hikari.call("/api/health"));
  check("the probe reports ok", health.ok === true, JSON.stringify(health.checks));
  const configured = Object.entries(health.checks || {}).filter(([, item]) => item.configured);
  check(
    "every configured service answers",
    configured.length === 8 && configured.every(([, item]) => item.ok),
    configured.filter(([, item]) => !item.ok).map(([name, item]) => `${name}: ${item.detail}`).join("; ") || `${configured.length} configured`
  );
  check("anilist itself is reachable", /ok/.test(health.checks?.anilist?.detail ?? ""), health.checks?.anilist?.detail);
  check(
    "the response carries cache counters without the snapshot path",
    typeof health.cache?.hits === "number" && typeof health.cache?.misses === "number" && !("snapshot" in (health.cache || {})) && health.cache?.persisted === true,
    JSON.stringify(health.cache)
  );
  check(
    "and a latency entry for every service that was called",
    ["jellyseerr", "sonarr", "radarr", "jellyfin", "shoko", "anilist", "qbittorrent"].every(
      name => typeof health.upstream?.[name]?.p50 === "number" && health.upstream[name].calls >= 1
    ),
    JSON.stringify(Object.fromEntries(Object.entries(health.upstream || {}).map(([k, v]) => [k, v.calls])))
  );
  check("uptime is reported", Number.isInteger(health.uptimeSeconds));

  // -------------------------------------------------------------------------------------------
  console.log("\ndiscover");

  const discover = await readJson(await hikari.call("/api/discover"));
  const rowIds = (discover.rows || []).map(row => row.id);
  check(
    "the six rows are present",
    ["airing", "trending", "upcoming", "top", "continuing"].every(id => rowIds.includes(id)),
    rowIds.join(",")
  );
  check("no integration reported a problem", Object.keys(discover.errors || {}).length === 0, JSON.stringify(discover.errors));

  const airing = (discover.rows || []).find(row => row.id === "airing");
  const frontier = airing?.media.find(item => item.id === 101);
  const orbit = airing?.media.find(item => item.id === 202);

  check("101 is in the airing row", Boolean(frontier));
  // Shoko supplies the TvDB id, Sonarr is keyed by it, so this match is by id rather than title.
  check(
    "101 matched the Sonarr series through Shoko's TvDB bridge",
    frontier?.library?.id === 7 && frontier?.library?.via === "shoko:tvdb",
    JSON.stringify(frontier?.library)
  );
  check("101 shows 2 episodes played in Jellyfin", frontier?.watch?.played === 2, JSON.stringify(frontier?.watch));
  check("101 is on the list as CURRENT", frontier?.list?.status === "CURRENT", JSON.stringify(frontier?.list));
  check("202 is in the airing row with no library match", Boolean(orbit) && orbit.library === null, JSON.stringify(orbit?.library));

  const continuing = (discover.rows || []).find(row => row.id === "continuing");
  const suggested = continuing?.media.find(item => item.id === 202);
  check(
    "202 is suggested as the sequel of the film that was finished",
    suggested?.because?.id === 303,
    JSON.stringify(suggested?.because)
  );

  // 202 is on the plan and has finished airing with nothing on disk: ready because there is nothing
  // left to wait for. 101 is CURRENT, not PLANNING, so it must not be here however ready it looks.
  const planningRow = (discover.rows || []).find(row => row.id === "planning");
  const plannedOrbit = planningRow?.media.find(item => item.id === 202);
  check("202 is in Ready to start because it has finished airing", plannedOrbit?.note === "Finished airing", JSON.stringify(plannedOrbit?.ready));
  check(
    "and the row holds only planned titles: not the one being watched, nor the completed film",
    planningRow?.media.every(item => item.id !== 101 && item.id !== 303) === true,
    JSON.stringify(planningRow?.media.map(item => item.id))
  );

  // -------------------------------------------------------------------------------------------
  console.log("\ndetail");

  const detail = await readJson(await hikari.call("/api/anime/101"));
  check("the body is the AniList entry", detail.id === 101 && detail.title?.display === "Frontier Saga");
  check("with the Sonarr match", detail.library?.id === 7, JSON.stringify(detail.library));
  check("with the Shoko entry", detail.shoko?.shokoId === 55, JSON.stringify(detail.shoko && { shokoId: detail.shoko.shokoId }));
  check(
    "Shoko's file list says 8 of 12 are missing",
    detail.shoko?.files?.missing?.length === 8,
    JSON.stringify(detail.shoko?.files?.missing)
  );
  check("with Jellyfin progress", detail.watch?.played === 2 && detail.watch?.episodes?.next?.episode === 3, JSON.stringify(detail.watch));
  check("with the list entry", detail.list?.status === "CURRENT" && detail.list?.progress === 2);
  check(
    "Jellyseerr resolved it to TMDB 60001, not yet requested",
    detail.request?.matched === true && detail.request?.tmdbId === 60001 && detail.request?.status === "none",
    JSON.stringify(detail.request && { matched: detail.request.matched, tmdbId: detail.request.tmdbId, status: detail.request.status })
  );
  check("the season is offered", detail.request?.seasons?.[0]?.taken === false && detail.request?.suggestedSeason === 1);
  check(
    "links point at the Jellyseerr media page",
    typeof detail.links?.media === "string" && detail.links.media.endsWith("/tv/60001"),
    detail.links?.media
  );
  check(
    "the franchise strip lists this season and the announced sequel, in order; the unaired one carries no library badge",
    Array.isArray(detail.franchise) &&
      detail.franchise.map(entry => entry.id).join(",") === "101,104" &&
      detail.franchise[0].current === true &&
      detail.franchise[0].library?.id === 7 &&
      detail.franchise[1].current === false &&
      detail.franchise[1].library === null,
    JSON.stringify(detail.franchise?.map(entry => ({ id: entry.id, current: entry.current, library: entry.library?.id ?? null })))
  );

  // One TMDB season and one Sonarr season that the AniList entry covers whole: nothing to narrow.
  check("no cour correction is proposed for a plain single-season show", detail.cours === null, JSON.stringify(detail.cours));

  const unowned = await readJson(await hikari.call("/api/anime/202"));
  check("202 resolves in Jellyseerr", unowned.request?.matched === true && unowned.request?.tmdbId === 60002);
  check("but is in no library", unowned.library === null && unowned.watch === null && unowned.shoko === null);
  // Its only relation is a film, and films are not seasons, so there is no chain to draw.
  check("a title whose only relation is a film has no franchise strip", unowned.franchise === null, JSON.stringify(unowned.franchise));

  const sequelDetail = await readJson(await hikari.call("/api/anime/104"));
  check(
    "opened from the strip, the sequel shows the same chain with itself marked",
    sequelDetail.franchise?.map(entry => `${entry.id}${entry.current ? "*" : ""}`).join(",") === "101,104*",
    JSON.stringify(sequelDetail.franchise?.map(entry => entry.id))
  );
  check(
    "TMDB has no anime keyword on it, so routing says an override is needed",
    unowned.routing?.treatedAsAnime === false && unowned.routing?.overridden === true,
    JSON.stringify(unowned.routing)
  );

  const bad = await hikari.call("/api/anime/abc");
  check("a non-numeric id is a 400", bad.status === 400, `got ${bad.status}`);
  const missing = await hikari.call("/api/anime/999");
  check("an id AniList does not know is a 404", missing.status === 404, `got ${missing.status}`);

  // -------------------------------------------------------------------------------------------
  console.log("\nrequesting");

  // Exactly the body src/components/Detail.tsx sends for a TV title: forceAnime is true because
  // routing said TMDB has not tagged it, so Hikari has to attach the anime profile and root itself.
  const requested = await hikari.call("/api/request", {
    method: "POST",
    body: { tmdbId: 60002, mediaType: "tv", seasons: [1], forceAnime: true, anilistId: 202, whole: false }
  });
  const created = await readJson(requested);
  check("the request is accepted", requested.status === 200 && created.ok === true && created.requestId === 900, `got ${requested.status} ${JSON.stringify(created)}`);
  check(
    "and the response says the anime override was applied",
    created.forcedAnime?.profileId === 2 && created.forcedAnime?.rootFolder === "/data/anime",
    JSON.stringify(created.forcedAnime)
  );
  check("nothing was started in Sonarr for a show with one season on both sides", created.narrowing === null, JSON.stringify(created.narrowing));

  const sent = fakes.calls.find(call => call.service === "jellyseerr" && call.method === "POST" && call.path === "/api/v1/request");
  check("Jellyseerr received one POST /request", Boolean(sent), JSON.stringify(sent?.body));
  check(
    "for TMDB 60002, as tv, season 1",
    sent?.body?.mediaType === "tv" && sent?.body?.mediaId === 60002 && Array.isArray(sent?.body?.seasons) && sent.body.seasons[0] === 1,
    JSON.stringify(sent?.body)
  );
  check(
    "with the anime profile and root folder from Jellyseerr's own Sonarr settings",
    sent?.body?.profileId === 2 && sent?.body?.rootFolder === "/data/anime" && sent?.body?.serverId === 0,
    JSON.stringify(sent?.body)
  );

  // The composed detail is cached, but the request route invalidates the Jellyseerr entries it was
  // built from and that sweeps the composed body too, so the very next read has to see the change.
  const after = await readJson(await hikari.call("/api/anime/202"));
  check("the detail now reports the title as pending", after.request?.status === "pending", JSON.stringify(after.request && { status: after.request.status }));
  check(
    "and the season as taken",
    after.request?.seasons?.length === 1 && after.request.seasons[0].taken === true,
    JSON.stringify(after.request?.seasons)
  );

  const duplicate = await hikari.call("/api/request", {
    method: "POST",
    body: { tmdbId: 60002, mediaType: "tv", seasons: [1], forceAnime: true, anilistId: 202, whole: false }
  });
  const refused = await readJson(duplicate);
  check("requesting it again is refused as a duplicate", duplicate.status === 409, `got ${duplicate.status}`);
  check(
    "naming the season that is already requested",
    /already requested/i.test(refused.error ?? "") && JSON.stringify(refused.alreadyRequested) === "[1]",
    JSON.stringify(refused)
  );
  const posts = fakes.calls.filter(call => call.service === "jellyseerr" && call.method === "POST" && call.path === "/api/v1/request");
  check("and Jellyseerr was not asked a second time", posts.length === 1, `${posts.length} POSTs`);

  const activity = await readJson(await hikari.call("/api/activity"));
  check(
    "the request shows up in activity",
    activity.requests?.some(item => item.id === 900 && item.tmdbId === 60002 && item.mediaStatus === "pending"),
    JSON.stringify(activity.requests)
  );

  // -------------------------------------------------------------------------------------------
  console.log("\nthe AniList list");

  const readOnly = await hikari.call("/api/list/101", { method: "POST", body: { progress: 3 } });
  check("writing is refused while ANILIST_ALLOW_WRITES is unset", readOnly.status === 403, `got ${readOnly.status}`);
  const mutations = () =>
    fakes.calls.filter(call => call.service === "anilist" && typeof call.body?.query === "string" && call.body.query.includes("SaveMediaListEntry"));
  check("and nothing reached AniList", mutations().length === 0, `${mutations().length} mutations`);

  hikari.stop();
  hikari = await startHikari({ fakes, env: { ANILIST_ALLOW_WRITES: "1" } });
  logs.push(hikari.logs);

  const listed = await readJson(await hikari.call("/api/list"));
  check("the list reads back as writable", listed.configured === true && listed.writable === true && listed.user?.name === "tester");

  const written = await hikari.call("/api/list/101", { method: "POST", body: { progress: 3 } });
  const saved = await readJson(written);
  check("with writes allowed the update is accepted", written.status === 200 && saved.ok === true, `got ${written.status} ${JSON.stringify(saved)}`);
  check("and the entry comes back with the new progress", saved.entry?.progress === 3, JSON.stringify(saved.entry));
  const mutation = mutations()[0];
  check(
    "AniList received one SaveMediaListEntry for 101 with progress 3",
    mutations().length === 1 && mutation?.body?.variables?.mediaId === 101 && mutation?.body?.variables?.progress === 3,
    JSON.stringify(mutation?.body?.variables)
  );
  const reread = await readJson(await hikari.call("/api/anime/101"));
  check("the detail reflects it on the next read", reread.list?.progress === 3, JSON.stringify(reread.list));

  // -------------------------------------------------------------------------------------------
  console.log("\nthe Jellyfin webhook");

  // This instance has writes allowed but scrobbling off: the hook must answer, and do nothing.
  const finished = (itemId, extra = {}) => ({
    event: "PlaybackStop",
    itemType: "Episode",
    itemId,
    seriesId: "jf-series-1",
    seriesName: "Frontier Saga",
    playedToCompletion: "True",
    userId: "user-1",
    ...extra
  });
  const mutationsBefore = mutations().length;

  const probe = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: { event: "Test" } }));
  check("the plugin's test ping is answered", probe.ok === true && probe.note === "webhook reachable" && probe.scrobbling === false, JSON.stringify(probe));

  const off = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4") }));
  check("with scrobbling off a finished episode is ignored, and says so", off.ok === true && off.ignored === true && off.reason === "scrobbling-off", JSON.stringify(off));
  check("and nothing reached AniList", mutations().length === mutationsBefore);

  hikari.stop();
  hikari = await startHikari({ fakes, env: { ANILIST_ALLOW_WRITES: "1", ANILIST_SCROBBLE: "1" } });
  logs.push(hikari.logs);

  // The list is at 3 from the write above. This series runs from episode 1 with no holes, so its
  // fourth item is episode 4 either way it is read; test-numbering covers the runs where the two
  // answers differ.
  const scrobbled = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4") }));
  check(
    "finishing episode 4 moves the list to 4",
    scrobbled.updated === true && scrobbled.anilistId === 101 && scrobbled.from === 3 && scrobbled.progress === 4 && scrobbled.via === "anilist",
    JSON.stringify(scrobbled)
  );
  const last = mutations().at(-1);
  check(
    "as one SaveMediaListEntry with progress 4 and status CURRENT",
    mutations().length === mutationsBefore + 1 && last?.body?.variables?.mediaId === 101 && last.body.variables.progress === 4 && last.body.variables.status === "CURRENT",
    JSON.stringify(last?.body?.variables)
  );

  const again = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4") }));
  check("the same event again is a no-op: progress never moves backwards or repeats", again.ignored === true && again.reason === "already-at-or-past" && mutations().length === mutationsBefore + 1, JSON.stringify(again));

  const earlier = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-2") }));
  check("rewatching an earlier episode does not pull the list back", earlier.ignored === true && earlier.reason === "already-at-or-past");

  const stopped = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4", { playedToCompletion: "False" }) }));
  check("stopping partway is not a finished episode", stopped.ignored === true && stopped.reason === "not-a-finished-episode");

  const someoneElse = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4", { userId: "user-2" }) }));
  check("another Jellyfin user's viewing is not written to your list", someoneElse.ignored === true && someoneElse.reason === "another-jellyfin-user");

  const anonymous = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-4", { userId: "" }) }));
  check("an event with no user cannot be attributed, so it is not written", anonymous.ignored === true && anonymous.reason === "no-jellyfin-user", JSON.stringify(anonymous));

  const unknown = await readJson(await hikari.call("/api/hooks/jellyfin", { method: "POST", body: finished("jf-ep-9", { seriesId: "jf-series-unknown" }) }));
  check("a series Hikari cannot place is refused with a reason, not guessed", unknown.ignored === true && unknown.reason === "series-not-in-jellyfin-index");

  const marked = await readJson(
    await hikari.call("/api/hooks/jellyfin", {
      method: "POST",
      body: { NotificationType: "UserDataSaved", ItemType: "Episode", ItemId: "jf-ep-4", SeriesId: "jf-series-1", Played: true, SaveReason: "TogglePlayed", UserId: "user-1" }
    })
  );
  check("the plugin's own property names are understood", marked.ok === true && marked.reason === "already-at-or-past", JSON.stringify(marked));
  check("the detail reflects the scrobbled progress", (await readJson(await hikari.call("/api/anime/101"))).list?.progress === 4);

  // -------------------------------------------------------------------------------------------
  console.log("\nthe Sonarr webhook");

  const hook = await hikari.call("/api/hooks/sonarr", { method: "POST", body: { eventType: "Test" } });
  const hooked = await readJson(hook);
  check("Sonarr's connection test is answered", hook.status === 200 && hooked.ok === true && hooked.event === "Test", JSON.stringify(hooked));

  // -------------------------------------------------------------------------------------------
  console.log("\nnot interested");

  const hid = await hikari.call("/api/hidden/202", { method: "POST", body: { title: "Orbit Drift" } });
  const hidBody = await readJson(hid);
  check("hiding a title is accepted", hid.status === 200 && hidBody.hidden === true && hidBody.count === 1, `got ${hid.status} ${JSON.stringify(hidBody)}`);

  const hiddenRows = await readJson(await hikari.call("/api/discover"));
  check(
    "it is gone from every Discover row, including Continue the story",
    (hiddenRows.rows || []).every(row => !row.media.some(item => item.id === 202)),
    (hiddenRows.rows || []).filter(row => row.media.some(item => item.id === 202)).map(row => row.id).join(",")
  );
  check("the other titles are untouched", (hiddenRows.rows || []).find(row => row.id === "airing")?.media.some(item => item.id === 101) === true);

  const hiddenSchedule = await readJson(await hikari.call("/api/schedule?days=14"));
  check("and from the schedule", Array.isArray(hiddenSchedule.items) && !hiddenSchedule.items.some(item => item.media?.id === 202));

  const stillSearchable = await readJson(await hikari.call("/api/search?q=orbit"));
  check("but search still finds it", (stillSearchable.media || []).some(item => item.id === 202), JSON.stringify((stillSearchable.media || []).map(item => item.id)));

  const flagged = await readJson(await hikari.call("/api/anime/202"));
  check("and the detail says so", flagged.hidden === true);

  const listed2 = await readJson(await hikari.call("/api/hidden"));
  check("the hidden list carries the title for the editor", listed2.hidden?.[0]?.id === 202 && listed2.hidden[0].title === "Orbit Drift", JSON.stringify(listed2));

  const badHide = await hikari.call("/api/hidden/abc", { method: "POST", body: {} });
  check("a non-numeric id is refused", badHide.status === 400, `got ${badHide.status}`);

  const shown = await readJson(await hikari.call("/api/hidden/202", { method: "DELETE", body: {} }));
  const back = await readJson(await hikari.call("/api/discover"));
  check(
    "bringing it back puts it in the rows again",
    shown.hidden === false && (back.rows || []).find(row => row.id === "continuing")?.media.some(item => item.id === 202) === true
  );
  check("and the detail flag clears", (await readJson(await hikari.call("/api/anime/202"))).hidden === false);

  // -------------------------------------------------------------------------------------------
  console.log("\nwarm-up");

  // The boot warm-up runs detached, so give it a moment before reading the log.
  for (let attempt = 0; attempt < 50 && !/discover warmed in/.test(hikari.logs()); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  check("the server built the Discover page on boot without being asked", /discover warmed in \d+ms/.test(hikari.logs()));

  // -------------------------------------------------------------------------------------------
  const unhandled = fakes.calls.filter(call => call.unhandled);
  check(
    "every upstream call hit a path the fakes know",
    unhandled.length === 0,
    unhandled.map(call => `${call.service} ${call.method} ${call.path}`).join(", ")
  );
} catch (err) {
  failures += 1;
  console.error(`\nthe test itself failed: ${err.stack || err.message}`);
} finally {
  hikari.stop();
  await fakes.stop();
}

if (failures > 0) {
  console.error("\n--- hikari log ---");
  for (const log of logs) console.error(log());
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
