import type { StateLabel as State } from "../format";

/** A plain-language state with a coloured dot. Hover shows what it means and the raw name. */
export function StateLabel(props: { state: State; raw: string | null }) {
  return (
    <span class="state" title={`${props.state.hint}${props.raw ? ` (${props.raw})` : ""}`.trim()}>
      <span class={["state-dot", props.state.tone]} aria-hidden="true" />
      {props.state.label}
    </span>
  );
}
