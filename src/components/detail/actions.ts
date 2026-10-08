import { createSignal } from "solid-js";
import {
  getList,
  hideAnime,
  showAnime,
  linkAllShokoFiles,
  linkShokoFile,
  markJellyfinPlayed,
  narrowToCour,
  postRequest,
  refreshJellyfinLibrary,
  rescanShokoFile,
  runShokoAction,
  saveListEntry,
  searchMissingEpisodes,
  setSonarrSeriesType,
  type MissingSearchPlan,
  type NarrowMode,
  type PlayedPlan,
  type ShokoAction
} from "../../api";
import { failureOutcome, resolveAction, type ActionResult, type Outcome } from "./outcome";
import { nextSelection, type Selection } from "./seasons";

export type { Outcome } from "./outcome";

type RunOptions = {
  /** Whether finishing should refetch the panel and the rows behind it. */
  refetch?: boolean;
};

export type DetailActions = ReturnType<typeof createDetailActions>;

/**
 * Every mutating action the detail panel offers, plus the state they share.
 *
 * The id is an accessor rather than a number because the panel is reused rather than remounted when
 * you open another title: the per-title state below is keyed by it, and a stale capture would write
 * one title's progress draft onto another.
 */
export function createDetailActions(options: { id: () => number; onRequested: () => void }) {
  const { id, onRequested } = options;

  const [busy, setBusy] = createSignal(false);
  const [outcomes, setOutcomes] = createSignal<Record<number, Outcome>>({});
  const [overrides, setOverrides] = createSignal<Record<number, Selection>>({});
  const [requested, setRequested] = createSignal<Record<number, Selection>>({});
  const [drafts, setDrafts] = createSignal<Record<number, number>>({});
  const [plans, setPlans] = createSignal<Record<number, MissingSearchPlan>>({});
  const [played, setPlayed] = createSignal<Record<number, PlayedPlan>>({});
  // Whether a request should skip the cour logic and take every season.
  const [wantsWhole, setWantsWhole] = createSignal<Record<number, boolean>>({});

  const [writable, setWritable] = createSignal(false);
  // Separate from writable: without a token there is no list at all, so the box that offers to add a
  // title has nothing to add to and must not appear.
  const [listConfigured, setListConfigured] = createSignal(false);

  let followUp: ReturnType<typeof setTimeout> | undefined;
  // Narrowing polls, so there are several timers rather than one. All of them are cleared on close.
  let narrowTimers: Array<ReturnType<typeof setTimeout>> = [];

  /**
   * The shape every action shares: hold the panel, do the work, report what happened, and let go
   * even when it threw. Written once because eleven hand-rolled copies had already drifted apart.
   */
  const run = async (work: () => Promise<ActionResult>, runOptions: RunOptions = {}) => {
    // Captured before the await, so a title opened mid-flight cannot be given someone else's notice.
    // It is also the only key the panel ever reads, which is why there is no option to vary it.
    const key = id();
    setBusy(true);
    try {
      const resolved = resolveAction(await work(), runOptions.refetch !== false);
      if (resolved) {
        setOutcomes(prev => ({ ...prev, [key]: resolved.outcome }));
        if (resolved.refetch) onRequested();
      }
    } catch (err) {
      setOutcomes(prev => ({ ...prev, [key]: failureOutcome(err) }));
    } finally {
      setBusy(false);
    }
  };

  // Whether AniList writes are permitted is server-side config, not something the UI knows.
  const loadPermissions = () =>
    getList()
      .then(result => {
        setWritable(Boolean(result.writable));
        setListConfigured(Boolean(result.configured));
      })
      .catch(() => {
        setWritable(false);
        setListConfigured(false);
      });

  const toggleSeason = (seasonNumber: number, current: Selection, allSeasons: number[]) => {
    setOverrides(prev => ({ ...prev, [id()]: nextSelection(seasonNumber, current, allSeasons) }));

    // Deliberately picking seasons after a request means you want another one.
    setRequested(prev => {
      const { [id()]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const draftProgress = (current: number) => drafts()[id()] ?? current;

  const setDraft = (value: number, max: number | null) => {
    const clamped = Math.min(Math.max(Math.trunc(value), 0), max ?? 9999);
    setDrafts(prev => ({ ...prev, [id()]: clamped }));
  };

  // Refetches the panel, which reads the flag live, and the rows behind it.
  const toggleHidden = (anilistId: number, title: string, hidden: boolean) =>
    run(async () => {
      await (hidden ? showAnime(anilistId) : hideAnime(anilistId, title));
      return hidden
        ? "Back in Discover and the schedule."
        : "Hidden from Discover, the schedule and the Homepage widget.";
    });

  const fixSeriesType = (seriesId: number) =>
    run(async () => {
      const result = await setSonarrSeriesType(seriesId, "anime");
      return result.changed
        ? `Sonarr series type changed from ${result.previous} to anime.`
        : "Sonarr already had this as anime.";
    });

  const saveList = (anilistId: number, payload: { status?: string; progress?: number }) =>
    run(async () => {
      const result = await saveListEntry(anilistId, payload);
      return `AniList updated: ${result.entry.status}, episode ${result.entry.progress}.`;
    });

  // Two steps on purpose: the first call only reads and returns the episodes it would grab, so the
  // confirm button is pressed against a concrete list rather than a hopeful guess.
  const planSearch = (anilistId: number, confirm: boolean) =>
    run(async () => {
      const plan = await searchMissingEpisodes(anilistId, confirm);
      setPlans(prev => ({ ...prev, [id()]: plan }));
      if (!plan.executed) return null;
      return `Sonarr is searching for ${plan.matched.length} episode${plan.matched.length === 1 ? "" : "s"}.`;
    });

  const repairShoko = (action: "rescan" | "link", anilistId: number, fileId: number) =>
    run(async () => {
      const result =
        action === "rescan" ? await rescanShokoFile(anilistId, fileId) : await linkShokoFile(anilistId, fileId);
      return action === "rescan"
        ? `Shoko is rescanning the file for episode ${result.episode}. Reopen this panel in a moment to see whether AniDB matched it.`
        : `Linked the file to episode ${result.episode}.`;
    });

  // Nothing about the panel's own data changes, so this one does not refetch.
  const refreshJellyfin = () =>
    run(
      async () => {
        const result = await refreshJellyfinLibrary();
        return result.scope === "library"
          ? `Jellyfin is scanning the ${result.library} library. Newly linked episodes appear once it finishes.`
          : "No anime library could be identified, so Jellyfin is scanning everything. Set JELLYFIN_LIBRARY_ID to narrow it.";
      },
      { refetch: false }
    );

  // Can half-succeed, so it reports its own ok rather than throwing or claiming success.
  const linkAll = (anilistId: number) =>
    run(async () => {
      const result = await linkAllShokoFiles(anilistId);
      return {
        ok: result.ok,
        message: result.ok
          ? `Linked ${result.linked.length} file(s): episode${result.linked.length === 1 ? "" : "s"} ${result.linked.join(", ")}. They should appear in Jellyfin once Shokofin refreshes.`
          : `Linked ${result.linked.length}, failed ${result.failed.length}: ${result.failed
              .map(item => `ep ${item.episode} (${item.error})`)
              .join("; ")}`
      };
    });

  const shokoAction = (action: ShokoAction) =>
    run(
      async () => {
        const result = await runShokoAction(action);
        // Queued, not done: Shoko runs these on its own worker and the counts move later.
        return `Shoko queued a job to ${result.label}. Reopen this panel in a minute to see the result.`;
      },
      { refetch: false }
    );

  const syncJellyfin = (anilistId: number, upTo: number | undefined, confirm: boolean) =>
    run(async () => {
      const plan = await markJellyfinPlayed(anilistId, upTo, confirm);
      setPlayed(prev => ({ ...prev, [id()]: plan }));
      if (!plan.executed) return null;
      return `Marked ${plan.marked} episode(s) played in Jellyfin.`;
    });

  // The server sweeps the download queue for about fifty seconds after the request, because grabs
  // from Jellyseerr's search keep arriving for that long. The last poll sits past its deadline so
  // the panel always settles on a finished state rather than a spinner.
  const NARROW_POLLS_MS = [4000, 12000, 24000, 36000, 48000, 58000, 70000];

  const pollNarrowing = () => {
    for (const delay of NARROW_POLLS_MS) {
      narrowTimers.push(setTimeout(() => onRequested(), delay));
    }
  };

  // Picking in the panel is the confirmation, so these apply directly.
  const narrowSeason = (anilistId: number, seasonNumber?: number, mode: NarrowMode = "exclusive") =>
    run(async () => {
      const result = await narrowToCour(anilistId, { seasonNumber, mode, confirm: true });
      // A refusal is reported, not thrown, so it has to say ok: false itself. Sonarr is still
      // monitoring every season at this point, and a green notice read as though it were not.
      if (!result.applied) return { ok: false, message: `Could not narrow Sonarr: ${result.reason}.` };
      return mode === "whole"
        ? `Sonarr is monitoring every season and searching what has aired.`
        : `Sonarr ${mode === "add" ? "also monitoring" : "narrowed to"} ${result.episodes.label} (${result.episodes.count} episode${result.episodes.count === 1 ? "" : "s"}).`;
    });

  const submit = (tmdbId: number, mediaType: string, selection: Selection, forceAnime: boolean) =>
    run(async () => {
      const payload =
        mediaType === "tv"
          ? {
              tmdbId,
              mediaType,
              seasons: selection === "all" ? ("all" as const) : selection,
              forceAnime,
              anilistId: id(),
              whole: wantsWhole()[id()] === true
            }
          : { tmdbId, mediaType };
      const created = await postRequest(payload);

      setRequested(prev => ({ ...prev, [id()]: selection }));
      // Drop the manual selection so the refreshed season statuses drive the default again.
      setOverrides(prev => {
        const { [id()]: _dropped, ...rest } = prev;
        return rest;
      });

      // Jellyseerr updates mediaInfo a beat after the POST returns. Tracked so closing the panel
      // cancels it rather than leaving a timer pointed at an unmounted component's callback.
      followUp = setTimeout(() => onRequested(), 2500);

      // Narrowing waits for Sonarr to add the series and then for the download queue to settle, so
      // its result lands long after the request response. Poll until it does.
      if (created.narrowing?.started) pollNarrowing();

      return created.forcedAnime
        ? `Requested in Jellyseerr (#${created.requestId}), forced to ${created.forcedAnime.rootFolder} with the anime profile.`
        : `Requested in Jellyseerr (request #${created.requestId}).${
            created.narrowing?.started
              ? created.narrowing.whole
                ? " Setting Sonarr to monitor every season now."
                : " Narrowing Sonarr to this cour now, which takes about a minute."
              : ""
          }`;
    });

  /** Called when the panel closes, so no timer is left pointed at an unmounted component. */
  const dispose = () => {
    if (followUp) clearTimeout(followUp);
    for (const timer of narrowTimers) clearTimeout(timer);
    narrowTimers = [];
  };

  return {
    busy,
    writable,
    listConfigured,
    loadPermissions,
    dispose,

    // Scoped to the open title, so the boxes never have to know the state is keyed by id.
    outcome: () => outcomes()[id()],
    plan: () => plans()[id()],
    playedPlan: () => played()[id()],
    selectionOverride: () => overrides()[id()],
    requestedSelection: () => requested()[id()],
    wholeSeries: () => wantsWhole()[id()] === true,
    setWholeSeries: (value: boolean) => setWantsWhole(prev => ({ ...prev, [id()]: value })),
    selectSeasons: (seasons: number[]) => setOverrides(prev => ({ ...prev, [id()]: seasons })),

    draftProgress,
    setDraft,
    toggleSeason,
    toggleHidden,
    fixSeriesType,
    saveList,
    planSearch,
    repairShoko,
    refreshJellyfin,
    linkAll,
    shokoAction,
    syncJellyfin,
    narrowSeason,
    submit
  };
}
