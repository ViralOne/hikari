import type { SeasonInfo } from "../../api";

/** Every open season, or an explicit list of season numbers. */
export type Selection = number[] | "all";

/**
 * What the season checkboxes start on, before you touch them.
 *
 * Nothing preselected is a deliberate outcome rather than a failure: with several seasons open and
 * no idea which one this AniList entry is, guessing would request the wrong half of a series.
 */
export function defaultSelection(
  seasons: SeasonInfo[] | null | undefined,
  suggested: number | null | undefined
): Selection {
  if (!seasons || seasons.length === 0) return "all";

  const suggestedSeason = suggested ? seasons.find(s => s.seasonNumber === suggested) : undefined;
  if (suggestedSeason && !suggestedSeason.taken) return [suggestedSeason.seasonNumber];

  const open = seasons.filter(s => !s.taken);
  if (open.length === 1) return [open[0].seasonNumber];

  return [];
}

/** The selection after one checkbox is clicked. */
export function nextSelection(seasonNumber: number, current: Selection, allSeasons: number[]): number[] {
  // "all" has to expand to the real season list first, otherwise unticking a box while "all" is
  // active reads as "not present -> add it" and selects only that season.
  const list = current === "all" ? allSeasons : current;
  return list.includes(seasonNumber)
    ? list.filter(n => n !== seasonNumber)
    : [...list, seasonNumber].sort((a, b) => a - b);
}
