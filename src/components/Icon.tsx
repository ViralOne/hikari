import { For } from "solid-js";

const PATHS: Record<string, string[]> = {
  compass: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "m15.8 8.2-2 5.6-5.6 2 2-5.6z"],
  calendar: [
    "M7 3v3",
    "M17 3v3",
    "M4 8.5A2.5 2.5 0 0 1 6.5 6h11A2.5 2.5 0 0 1 20 8.5v9A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z",
    "M4 11h16",
    "M9 15h2"
  ],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14", "m16.2 16.2 3.8 3.8"],
  pulse: ["M3 12h3.5l2.5-6 3.5 12 2.5-6H21"],
  external: ["M14 4h6v6", "M20 4 11 13", "M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"],
  refresh: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  close: ["M6 6l12 12", "M18 6 6 18"]
};

export function Icon(props: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      class="icon"
      width={props.size ?? 17}
      height={props.size ?? 17}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <For each={PATHS[props.name] ?? []}>{path => <path d={path} />}</For>
    </svg>
  );
}
