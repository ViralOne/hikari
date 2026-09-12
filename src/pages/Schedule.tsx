import { createMemo, createSignal, For, Loading, Repeat, Show } from "solid-js";
import { getSchedule, type ScheduleEntry } from "../api";
import { LibraryBadge } from "../components/Badges";
import { clockTime, dateLabel, dayKey, dayLabel } from "../format";

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
          <div class="day-group">
            <Repeat count={6}>
              {() => <div class="skeleton" style={{ height: "74px", "margin-bottom": "10px" }} />}
            </Repeat>
          </div>
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
                          {cover => <img src={cover()} alt="" loading="lazy" />}
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
