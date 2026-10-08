import { createMemo, Loading, onSettled, Show } from "solid-js";
import { createDetailActions } from "./detail/actions";
import { createDetailFetcher } from "./detail/cache";
import { AniListBox } from "./detail/AniListBox";
import { FranchiseStrip } from "./detail/FranchiseStrip";
import { PanelHeader } from "./detail/PanelHeader";
import { PanelLinks } from "./detail/PanelLinks";
import { ProgressBox } from "./detail/ProgressBox";
import { RequestBox } from "./detail/RequestBox";
import { ShokoBox } from "./detail/ShokoBox";
import { SonarrBox } from "./detail/SonarrBox";
import { Icon } from "./Icon";

export function Detail(props: {
  id: number;
  token: number;
  onClose: () => void;
  onRequested: () => void;
  /** Opens another title in this same panel; used by the franchise strip. */
  onOpen?: (id: number) => void;
}) {
  const { revision, fetchDetail } = createDetailFetcher();
  const detail = createMemo(() => fetchDetail(props.id, props.token, revision()));

  const actions = createDetailActions({
    id: () => props.id,
    onRequested: () => props.onRequested()
  });

  // Move focus into the panel on open, keep Tab inside it, and hand focus back to whatever
  // opened it on close. Without this a keyboard user tabs into the page behind the panel.
  let panelRef: HTMLElement | undefined;
  const opener = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);

  onSettled(() => {
    panelRef?.focus();
    actions.loadPermissions();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !panelRef) return;

      const focusable = [
        ...panelRef.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ].filter(element => element.offsetParent !== null);

      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef)) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      actions.dispose();
      opener?.focus?.();
    };
  });

  return (
    <>
      <div class="panel-scrim" onClick={() => props.onClose()} />
      <aside
        class="panel"
        ref={element => (panelRef = element)}
        role="dialog"
        aria-modal="true"
        aria-label="Anime details"
        tabindex="-1"
      >
        <button class="panel-close" onClick={() => props.onClose()} aria-label="Close details">
          <Icon name="close" size={17} />
        </button>

        <Loading fallback={<div class="skeleton" style={{ height: "210px" }} />} on={props.id}>
          <Show when={detail()}>
            {anime => (
              <>
                <div
                  class="panel-hero"
                  style={{ "background-image": `url(${anime().banner || anime().cover || ""})` }}
                />

                <div class="panel-body">
                  <PanelHeader anime={anime()} />

                  <Show when={anime().franchise}>
                    {chain => (
                      <FranchiseStrip chain={chain()} busy={actions.busy()} onOpen={props.onOpen} />
                    )}
                  </Show>

                  <Show when={actions.outcome()}>
                    {outcome => (
                      <div class={["notice", outcome().ok ? "ok" : "bad"]} role="status" aria-live="polite">
                        {outcome().message}
                      </div>
                    )}
                  </Show>

                  <ProgressBox anime={anime()} actions={actions} />
                  <AniListBox anime={anime()} actions={actions} />
                  <ShokoBox anime={anime()} actions={actions} />
                  <SonarrBox anime={anime()} actions={actions} />
                  <RequestBox anime={anime()} actions={actions} />
                  <PanelLinks anime={anime()} actions={actions} />
                </div>
              </>
            )}
          </Show>
        </Loading>
      </aside>
    </>
  );
}
