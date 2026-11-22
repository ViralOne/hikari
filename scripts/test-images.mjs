// AniList images served from Hikari: only AniList anime covers and banners, kept on disk, pruned by
// last use. Run: npm test
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "hikari-img-"));
process.env.IMAGE_CACHE_DIR = dir;
const images = await import("../server/images.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("what may be fetched");
check("a cover in each size", ["large", "medium", "small"].every(size => images.allowed(`media/anime/cover/${size}/bx100561-UfF71wKjNiZ3.jpg`)));
check("a banner", images.allowed("media/anime/banner/154587-ivXNJ23SM1xB.jpg"));
check("no climbing out of the folder", !images.allowed("media/anime/cover/large/../../../user/x.jpg") && !images.allowed("media/anime/cover/large/%2e%2e/x.jpg"));
check("nothing that is not an anime image", !images.allowed("media/user/avatar/large/1.png") && !images.allowed("media/anime/cover/large/x.svg") && !images.allowed("media/anime/cover/large/x.html"));
check("an AniList URL becomes a local path", images.localPath("https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-a.jpg") === "/img/anilist/media/anime/cover/large/bx1-a.jpg");
check("any other URL is left alone", images.localPath("https://evil.example/media/anime/cover/large/bx1-a.jpg") === "https://evil.example/media/anime/cover/large/bx1-a.jpg");

console.log("fetching and keeping");
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
let requests = [];
globalThis.fetch = async url => {
  requests.push(url);
  if (url.includes("missing")) return { ok: false, status: 404, headers: new Headers() };
  if (url.includes("notimage")) return { ok: true, status: 200, headers: new Headers({ "content-type": "text/html" }), arrayBuffer: async () => new ArrayBuffer(4) };
  return { ok: true, status: 200, headers: new Headers({ "content-type": "image/jpeg" }), arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length) };
};
const path = "media/anime/cover/medium/bx1-a.jpg";
const first = await images.get(path);
check("the first view asks AniList, on its one host", requests.length === 1 && requests[0] === `https://s4.anilist.co/file/anilistcdn/${path}`);
check("and answers with the image", first?.type === "image/jpeg" && first.body.equals(jpeg));
requests = [];
const [a, b] = await Promise.all([images.get("media/anime/cover/small/bx2-b.jpg"), images.get("media/anime/cover/small/bx2-b.jpg")]);
check("two views at once fetch it once", requests.length === 1 && a && b);
requests = [];
await images.get(path);
check("after that it comes from disk", requests.length === 0 && images.status().hits >= 1);
check("a missing image is null, not an error", (await images.get("media/anime/cover/large/missing.jpg")) === null);
let refused = false;
try { await images.get("media/anime/cover/large/notimage.jpg"); } catch { refused = true; }
check("something that is not an image is refused", refused);
check("and not kept", readdirSync(dir).length === 2);

requests = [];
const warmed = await images.prewarm([
  "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx3-c.jpg",
  "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx1-a.jpg",
  "https://elsewhere.example/x.jpg"
]);
check("prewarming fetches only what is not on disk yet, and only AniList's", warmed === 1 && requests.length === 1);

console.log("pruning");
const now = Date.now() / 1000;
const files = readdirSync(dir).map(name => join(dir, name));
for (const [i, file] of files.entries()) {
  writeFileSync(file, Buffer.alloc(30 * 1024 * 1024));
  utimesSync(file, now - (files.length - i) * 60, now - (files.length - i) * 60);
}
images.configure({ limitMb: 50 });
const result = images.prune();
const left = readdirSync(dir).map(name => join(dir, name));
check("over the limit, the least recently used go first", result.removed === files.length - 1 && left.length === 1 && left[0] === files[files.length - 1],
  `${result.removed} removed, ${left.length} left`);

rmSync(dir, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
