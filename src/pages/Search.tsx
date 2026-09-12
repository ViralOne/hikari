import { createMemo, createSignal, For, Loading, Repeat, Show } from "solid-js";
import { getSearch } from "../api";
import { Card, CardSkeleton } from "../components/Card";
import { Icon } from "../components/Icon";

const SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"];
const FORMATS = ["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"];
const GENRES = [
  "Action",
  "Adventure",
  "Comedy",
  "Drama",
  "Ecchi",
  "Fantasy",
  "Horror",
  "Mahou Shoujo",
  "Mecha",
  "Music",
  "Mystery",
  "Psychological",
  "Romance",
  "Sci-Fi",
  "Slice of Life",
  "Sports",
  "Supernatural",
  "Thriller"
];

const YEARS = Array.from({ length: 30 }, (_unused, index) => new Date().getFullYear() + 1 - index);

export function Search(props: { token: number; onOpen: (id: number) => void }) {
  const [text, setText] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [season, setSeason] = createSignal("");
  const [year, setYear] = createSignal("");
  const [format, setFormat] = createSignal("");
  const [genre, setGenre] = createSignal("");

  const params = createMemo(() => ({
    q: query(),
    season: season(),
    year: year(),
    format: format(),
    genre: genre(),
    token: String(props.token)
  }));

  const active = createMemo(() => {
    const current = params();
    return Boolean(current.q || current.season || current.year || current.format || current.genre);
  });

  const results = createMemo(() => (active() ? getSearch(params()) : Promise.resolve({ media: [] })));

  const reset = () => {
    setText("");
    setQuery("");
    setSeason("");
    setYear("");
    setFormat("");
    setGenre("");
  };

  return (
    <>
      <form
        class="toolbar"
        onSubmit={event => {
          event.preventDefault();
          setQuery(text().trim());
        }}
      >
        <label class="field">
          <span style={{ color: "var(--text-faint)", display: "flex" }}>
            <Icon name="search" size={16} />
          </span>
          <input
            type="search"
            placeholder="Search AniList…"
            value={text()}
            onInput={event => setText(event.currentTarget.value)}
          />
        </label>

        <select class="field" value={season()} onChange={event => setSeason(event.currentTarget.value)}>
          <option value="">Any season</option>
          <For each={SEASONS}>
            {value => <option value={value}>{value.charAt(0) + value.slice(1).toLowerCase()}</option>}
          </For>
        </select>

        <select class="field" value={year()} onChange={event => setYear(event.currentTarget.value)}>
          <option value="">Any year</option>
          <For each={YEARS}>{value => <option value={String(value)}>{value}</option>}</For>
        </select>

        <select class="field" value={format()} onChange={event => setFormat(event.currentTarget.value)}>
          <option value="">Any format</option>
          <For each={FORMATS}>{value => <option value={value}>{value.replace("_", " ")}</option>}</For>
        </select>

        <select class="field" value={genre()} onChange={event => setGenre(event.currentTarget.value)}>
          <option value="">Any genre</option>
          <For each={GENRES}>{value => <option value={value}>{value}</option>}</For>
        </select>

        <button class="btn primary" type="submit">
          Search
        </button>
        <Show when={active()}>
          <button class="btn ghost" type="button" onClick={reset}>
            Clear
          </button>
        </Show>
      </form>

      <section class="section">
        <Show
          when={active()}
          fallback={
            <div class="empty">
              <strong>Find anime</strong>
              Type a title, or pick a season and year to browse — for example Winter 2026.
            </div>
          }
        >
          <Loading
            fallback={
              <div class="grid">
                <Repeat count={12}>{() => <CardSkeleton />}</Repeat>
              </div>
            }
          >
            <Show
              when={results().media.length > 0}
              fallback={
                <div class="empty">
                  <strong>No matches</strong>
                  AniList returned nothing for those filters.
                </div>
              }
            >
              <div class="section-head">
                <h2 class="section-title">{results().media.length} results</h2>
                <span class="section-note">
                  {results().media.filter(item => item.library).length} already in library
                </span>
              </div>
              <div class="grid">
                <For each={results().media}>
                  {item => <Card anime={item} onOpen={props.onOpen} />}
                </For>
              </div>
            </Show>
          </Loading>
        </Show>
      </section>
    </>
  );
}
