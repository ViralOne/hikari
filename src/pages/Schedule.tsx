import { createMemo, createSignal, For, Loading, Repeat, Show } from "solid-js";
import { getSchedule, type ScheduleEntry } from "../api";
import { LibraryBadge } from "../components/Badges";
import { clockTime, dateLabel, dayKey, dayLabel } from "../format";
import { cover as coverSet } from "../img";

const fetchSchedule = (days: number, _token: number) => getSchedule(days);

export function Schedule(props: { token: number; onOpen: (id: number) => void }) {
  const [days, setDays] = createSignal(7);
  const [onlyLibrary, setOnlyLibrary] = createSignal(false);

  const data = createMemo(() => fetchSchedule(days(), props.token));

  const groups = createMemo(() => {
    const items = data().items.filter(entry => (onlyLibrary() ? entry.media.library : true));
    const buckets = new Map<string, { airingAt: number; entries: ScheduleEntry[] }>();

    for (const entry of items) {
      const key = dayKey(entry.airingAt);
      const bucket = buckets.get(key);
      if (bucket) bucket.entries.push(entry);
      else buckets.set(key, { airingAt: entry.airingAt, entries: [entry] });
    }
    return [...buckets.values()].sort((a, b) => a.airingAt - b.airingAt);
  });

  return (
    <>
      <div class="toolbar">
        <select
          class="field"
          value={String(days())}
          onChange={event => setDays(Number(event.currentTarget.value))}
        >
          <option value="3">Next 3 days</option>
          <option value="7">Next 7 days</option>
          <option value="14">Next 14 days</option>
        </select>
        <button
          class={["btn", onlyLibrary() ? "primary" : "ghost"]}
          onClick={() => setOnlyLibrary(value => !value)}
        >
          Only my library
        </button>
      </div>

      <Loading
        fallback={
          <Repeat count={2}>
            {() => (
              <section class="day-group" aria-hidden="true">
                <div class="day-head">
                  <span class="skeleton skel-line" style={{ width: "72px", height: "15px" }} />
                  <span class="skeleton skel-line" style={{ width: "48px" }} />
                  <i class="hr" />
                  <span class="skeleton skel-line" style={{ width: "64px" }} />
                </div>
                <div class="ep-list">
                  <Repeat count={6}>
                    {() => (
                      <div class="ep skel-ep">
                        <span class="skeleton skel-cover" />
                        <div class="ep-info">
                          <span class="skeleton skel-line" style={{ width: "70%", height: "13px" }} />
                          <span class="skeleton skel-line" style={{ width: "34%", "margin-top": "6px" }} />
                        </div>
                        <span class="skeleton skel-line" style={{ width: "38px" }} />
                      </div>
                    )}
                  </Repeat>
                </div>
              </section>
            )}
          </Repeat>
        }
        on={days()}
      >
        <Show
          when={groups().length > 0}
          fallback={
            <div class="empty">
              <strong>Nothing scheduled</strong>
              {onlyLibrary() ? "No episodes from your library air in this window." : "AniList returned no airings."}
            </div>
          }
        >
          <For each={groups()}>
            {group => (
              <section class="day-group">
                <div class="day-head">
                  <span class="day-name">{dayLabel(group.airingAt)}</span>
                  <span class="day-date">{dateLabel(group.airingAt)}</span>
                  <i class="hr" />
                  <span class="day-date">{group.entries.length} episodes</span>
                </div>
                <div class="ep-list">
                  <For each={group.entries}>
                    {entry => (
                      <button class="ep" onClick={() => props.onOpen(entry.media.id)}>
                        <Show when={entry.media.cover}>
                          {cover => {
                            const image = coverSet(cover(), "40px");
                            return <img src={image.src} srcset={image.srcset} sizes={image.sizes} alt="" loading="lazy" decoding="async" />;
                          }}
                        </Show>
                        <div class="ep-info">
                          <div class="ep-title">{entry.media.title.display}</div>
                          <div class="ep-sub">Episode {entry.episode}</div>
                        </div>
                        <LibraryBadge library={entry.media.library} />
                        <span class="ep-time">{clockTime(entry.airingAt)}</span>
                      </button>
                    )}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </Loading>
    </>
  );
}
