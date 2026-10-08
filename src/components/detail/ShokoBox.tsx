import { For, Show } from "solid-js";
import type { AnimeDetail } from "../../api";
import { bytes } from "../../format";
import type { DetailActions } from "./actions";

/** What Shoko has matched against AniDB, and the repairs for each way it can fall short. */
export function ShokoBox(props: { anime: AnimeDetail; actions: DetailActions }) {
  const actions = () => props.actions;

  return (
    <Show when={props.anime.shoko}>
      {info => (
        <div class="box">
          <div class="box-head">
            <span class="box-title">Shoko / AniDB</span>
            <span class="badge">matched by {info().via}</span>
          </div>
          <dl class="kv">
            <dt>Episodes</dt>
            <dd>
              {info().onDisk} of {info().totalEpisodes} on disk
              {/* Shoko calls these missing, which is only true from its own side. Say counted
                  instead when the files are demonstrably there. */}
              <Show when={info().missing > 0}>
                <span class="dim">
                  {" "}
                  ·{" "}
                  {(info().report?.counts.onDiskUnlinked ?? 0) + (info().report?.counts.onDiskNotHashed ?? 0) ===
                  info().missing
                    ? `${info().missing} not counted`
                    : `${info().missing} missing`}
                </span>
              </Show>
            </dd>
          </dl>
          {/* "Missing episodes: 6, 8, 11" on its own sent me hunting for a download that had already
              happened. Each row now says which of the four different things "missing" means, and
              offers the matching fix. */}
          <Show
            when={info().report}
            fallback={
              <Show when={info().files?.missing?.length}>
                <div class="notice warn">Missing episodes: {info().files!.missing.join(", ")}</div>
              </Show>
            }
          >
            {report => (
              <div class="plan">
                {/* Not "without a file": most of these have a file, Shoko just is not using it, and
                    the two readings together look like a contradiction. */}
                <div class="box-title">
                  {report().rows.length} episode{report().rows.length === 1 ? "" : "s"} Shoko is not counting
                </div>

                <For each={report().rows}>
                  {row => (
                    <div class="plan-row">
                      <span class="plan-ep">ep {row.episode ?? "?"}</span>
                      <span class={["plan-state", row.state]}>
                        {row.state === "not-downloaded"
                          ? "not downloaded"
                          : row.state === "on-disk-unlinked"
                            ? "downloaded · not linked in Shoko"
                            : row.state === "on-disk-not-hashed"
                              ? "downloaded · Shoko has not scanned it"
                              : row.state === "not-aired"
                                ? "not aired yet"
                                : (row.detail ?? "unresolved")}
                      </span>
                      <span class="plan-date">
                        <Show when={row.sonarr}>
                          {sonarr => (
                            <>
                              S{String(sonarr().seasonNumber).padStart(2, "0")}E
                              {String(sonarr().episodeNumber).padStart(2, "0")}
                              <Show when={sonarr().size}>{size => <> · {bytes(size())}</>}</Show>
                              {" · "}
                            </>
                          )}
                        </Show>
                        {row.airDate ?? "no air date"}
                      </span>

                      <Show when={row.state === "on-disk-unlinked" ? row.shokoFile : null}>
                        {file => (
                          <span class="plan-actions">
                            <button
                              class="btn tiny ghost"
                              disabled={actions().busy()}
                              title="Ask AniDB about this file again"
                              onClick={() => actions().repairShoko("rescan", props.anime.id, file().fileId)}
                            >
                              Rescan
                            </button>
                            <Show when={row.shokoEpisodeId}>
                              <button
                                class="btn tiny"
                                disabled={actions().busy()}
                                title="Link this file to the AniDB episode by hand"
                                onClick={() => actions().repairShoko("link", props.anime.id, file().fileId)}
                              >
                                Link to ep {row.episode}
                              </button>
                            </Show>
                          </span>
                        )}
                      </Show>
                    </div>
                  )}
                </For>

                <Show when={report().counts.onDiskUnlinked > 0}>
                  <div class="hint">
                    Rescan asks AniDB about the file again. If AniDB has no record of that release, linking by
                    hand is the fix: it only writes a cross reference, nothing on disk changes. Across the whole
                    collection Shoko has {report().collection.unlinked} unlinked file
                    {report().collection.unlinked === 1 ? "" : "s"} of {report().collection.files}.
                  </div>
                  {/* The per-file buttons fix one episode. These fix the class, which matters when
                      the same gap covers dozens of files. */}
                  <div class="chips">
                    <Show when={report().counts.onDiskUnlinked > 1}>
                      <button
                        class="btn tiny"
                        disabled={actions().busy()}
                        title="Link every unmatched file of this title to its episode"
                        onClick={() => actions().linkAll(props.anime.id)}
                      >
                        Link all {report().counts.onDiskUnlinked}
                      </button>
                    </Show>
                    <button
                      class="btn tiny ghost"
                      disabled={actions().busy()}
                      title="Ask AniDB again for every file it has no record for"
                      onClick={() => actions().shokoAction("refresh-anidb")}
                    >
                      Retry AniDB on all {report().collection.unlinked}
                    </button>
                    <button
                      class="btn tiny ghost"
                      disabled={actions().busy()}
                      title="Drop database rows for files that are no longer on disk. Your AniDB list is not touched."
                      onClick={() => actions().shokoAction("forget-deleted")}
                    >
                      Forget deleted files
                    </button>
                    <button
                      class="btn tiny ghost"
                      disabled={actions().busy()}
                      title="Hash anything in the import folder Shoko has not seen yet"
                      onClick={() => actions().shokoAction("import-new")}
                    >
                      Import new files
                    </button>
                    {/* Linking in Shoko is not enough on its own: Shokofin only exposes the file
                        after Jellyfin scans the library. */}
                    <button
                      class="btn tiny ghost"
                      disabled={actions().busy()}
                      title="Make Jellyfin pick up newly linked files now instead of at its next 12-hourly scan"
                      onClick={() => actions().refreshJellyfin()}
                    >
                      Scan anime library
                    </button>
                  </div>
                </Show>

                <Show when={report().counts.onDiskNotHashed > 0}>
                  <div class="hint">
                    Files Shoko has never scanned need an import run: Shoko, Utilities, Actions, Import Folder
                    Scan.
                  </div>
                </Show>

                <Show when={report().counts.notDownloaded > 0}>
                  <Show
                    when={actions().plan()}
                    fallback={
                      <button
                        class="btn"
                        disabled={actions().busy()}
                        onClick={() => actions().planSearch(props.anime.id, false)}
                      >
                        Look for the {report().counts.notDownloaded} missing file
                        {report().counts.notDownloaded === 1 ? "" : "s"} in Sonarr
                      </button>
                    }
                  >
                    {plan => (
                      <>
                        <div class="box-title">
                          {plan().executed ? "Searching" : "Would search"} {plan().matched.length} episode
                          {plan().matched.length === 1 ? "" : "s"}
                        </div>
                        <For each={plan().matched}>
                          {item => (
                            <div class="plan-row">
                              <span class="plan-ep">
                                S{String(item.seasonNumber).padStart(2, "0")}E
                                {String(item.episodeNumber).padStart(2, "0")}
                              </span>
                              <span class="dim">{item.title ?? "untitled"}</span>
                              <span class="plan-date">
                                <Show when={!item.monitored}>will be monitored · </Show>
                                {item.airDate}
                              </span>
                            </div>
                          )}
                        </For>
                        <Show when={!plan().executed}>
                          <button
                            class="btn primary"
                            disabled={actions().busy()}
                            onClick={() => actions().planSearch(props.anime.id, true)}
                          >
                            Search Sonarr now
                          </button>
                          <div class="hint">
                            This asks your indexers for these episodes and downloads whatever they return.
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                </Show>
              </div>
            )}
          </Show>
          <Show when={info().files?.groups?.length}>
            <dl class="kv">
              <dt>Release groups</dt>
              <dd>{info().files!.groups.map(group => `${group.name} (${group.count})`).join(", ")}</dd>
            </dl>
          </Show>
          <Show when={info().files?.mixedGroups}>
            <div class="hint">
              More than one release group in this season, so encoding and subtitle style may change between
              episodes.
            </div>
          </Show>
          <Show when={info().sources.length}>
            <dl class="kv">
              <dt>Sources</dt>
              <dd>{info().sources.map(source => `${source.name} (${source.count})`).join(", ")}</dd>
            </dl>
          </Show>
        </div>
      )}
    </Show>
  );
}
