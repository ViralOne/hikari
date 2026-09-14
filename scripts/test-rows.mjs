import { move, order, reconcile, toggle } from "../src/rows.ts";

// The row layout is stored in the browser and outlives the version that wrote it, so reconcile() has
// to cope with a saved value from an older Hikari, a hand-edited one, and outright junk. Run with
// node's type stripping, which npm test does for us.

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

const AVAILABLE = ["continuing", "airing", "trending", "upcoming", "top"];
const ids = layout => layout.map(row => row.id).join(",");
const shown = layout => layout.filter(row => row.visible).map(row => row.id).join(",");

console.log("first run and upgrades");

check("with nothing saved, every row shows in the server's order", ids(reconcile(null, AVAILABLE)) === AVAILABLE.join());
check("a row the saved layout has never seen is appended, not hidden", (() => {
  const layout = reconcile([{ id: "airing", visible: true }, { id: "top", visible: false }], AVAILABLE);
  return ids(layout) === "airing,top,continuing,trending,upcoming" && shown(layout) === "airing,continuing,trending,upcoming";
})());
check(
  "a row that no longer exists is dropped",
  ids(reconcile([{ id: "gone", visible: true }, { id: "airing", visible: true }], AVAILABLE)) ===
    "airing,continuing,trending,upcoming,top"
);
check("your order is kept", ids(reconcile(AVAILABLE.slice().reverse().map(id => ({ id, visible: true })), AVAILABLE)) === "top,upcoming,trending,airing,continuing");
check("hidden stays hidden across a reconcile", shown(reconcile([{ id: "top", visible: false }], AVAILABLE)) === "continuing,airing,trending,upcoming");

console.log("\njunk does not wedge the page");

check("a duplicate id is only counted once", ids(reconcile([{ id: "airing" }, { id: "airing" }], AVAILABLE)).split(",").filter(id => id === "airing").length === 1);
check("a non-array is ignored", ids(reconcile("not a layout", AVAILABLE)) === AVAILABLE.join());
check("entries that are not objects are skipped", ids(reconcile([null, 42, "airing", { id: "top", visible: true }], AVAILABLE)) === "top,continuing,airing,trending,upcoming");
check("a missing visible flag counts as visible", reconcile([{ id: "airing" }], AVAILABLE)[0].visible === true);
check("an empty available list gives an empty layout", reconcile([{ id: "airing", visible: true }], []).length === 0);

console.log("\nmoving");

const base = reconcile(null, AVAILABLE);
check("up swaps with the row above", ids(move(base, "airing", -1)) === "airing,continuing,trending,upcoming,top");
check("down swaps with the row below", ids(move(base, "continuing", 1)) === "airing,continuing,trending,upcoming,top");
check("up at the top does nothing", ids(move(base, "continuing", -1)) === AVAILABLE.join());
check("down at the bottom does nothing", ids(move(base, "top", 1)) === AVAILABLE.join());
check("an unknown id does nothing", ids(move(base, "nope", 1)) === AVAILABLE.join());
check("the original is not mutated", ids(base) === AVAILABLE.join());

console.log("\nhiding");

check("toggle flips one row only", shown(toggle(base, "trending")) === "continuing,airing,upcoming,top");
check("toggling twice returns to the start", shown(toggle(toggle(base, "trending"), "trending")) === AVAILABLE.join());
check("toggle does not reorder", ids(toggle(base, "trending")) === AVAILABLE.join());

console.log("\napplying to the server's rows");

const serverRows = AVAILABLE.map(id => ({ id, media: [] }));
check("hidden rows are removed", order(serverRows, toggle(base, "top")).map(r => r.id).join() === "continuing,airing,trending,upcoming");
// Four presses of "up", the way the buttons actually drive it, walk a row from last to first.
const walkedUp = [1, 2, 3, 4].reduce(layout => move(layout, "top", -1), base);
check("rows come back in the layout's order", order(serverRows, walkedUp).map(r => r.id).join() === "top,continuing,airing,trending,upcoming", ids(walkedUp));
check("a swap by more than one is a swap, not an insert", ids(move(base, "top", -4)) === "top,airing,trending,upcoming,continuing");
check("a layout entry with no matching row is skipped", order([{ id: "airing", media: [] }], base).map(r => r.id).join() === "airing");
check("everything hidden gives nothing rather than throwing", order(serverRows, base.map(row => ({ ...row, visible: false }))).length === 0);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
