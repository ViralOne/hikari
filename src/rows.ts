export type RowLayout = { id: string; visible: boolean }[];

const KEY = "hikari:rows";

/**
 * Reconciles a saved layout against the rows the server actually sent.
 *
 * Kept separate from the storage so it can be tested, and because it carries the decisions that
 * matter: your order survives, a row added in a later version appears rather than being silently
 * hidden, a row that no longer exists disappears, and a corrupt entry cannot wedge the page.
 */
export function reconcile(saved: unknown, available: string[]): RowLayout {
  const layout: RowLayout = [];
  const seen = new Set<string>();

  if (Array.isArray(saved)) {
    for (const entry of saved) {
      const id = typeof entry?.id === "string" ? entry.id : null;
      // Dropping unknown ids is what stops a renamed row from lingering forever.
      if (!id || seen.has(id) || !available.includes(id)) continue;
      seen.add(id);
      layout.push({ id, visible: entry.visible !== false });
    }
  }

  // Anything the server offers that the saved layout has never heard of goes on the end, visible.
  // A new row defaulting to hidden would look like it had failed to ship.
  for (const id of available) {
    if (!seen.has(id)) layout.push({ id, visible: true });
  }

  return layout;
}

/** Swaps a row with its neighbour. Moving past either end is a no-op rather than a wrap-around. */
export function move(layout: RowLayout, id: string, delta: number): RowLayout {
  const from = layout.findIndex(row => row.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= layout.length) return layout;

  const next = layout.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function toggle(layout: RowLayout, id: string): RowLayout {
  return layout.map(row => (row.id === id ? { ...row, visible: !row.visible } : row));
}

/** Applies the layout to the server's rows: hidden ones out, the rest in your order. */
export function order<T extends { id: string }>(rows: T[], layout: RowLayout): T[] {
  const byId = new Map(rows.map(row => [row.id, row]));
  return layout.flatMap(entry => {
    const row = byId.get(entry.id);
    return entry.visible && row ? [row] : [];
  });
}

// Per browser rather than per install: this is a view preference, and putting it in the settings file
// would make it an administrator-only change once the login is on.
export function load(): unknown {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // Private windows and disabled storage both throw here. A default layout is a fine outcome.
    return null;
  }
}

export function save(layout: RowLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Not being able to remember the choice is better than not being able to make it.
  }
}
