// AniList images through Hikari (/img/anilist/...), which keeps them on the NAS and marks them as
// never changing, so the browser and Cloudflare cache them. The server only serves AniList's anime
// covers and banners; anything else is left as it is.
const ORIGIN = "https://s4.anilist.co/file/anilistcdn/";
const COVER = /\/cover\/(?:large|medium|small)\//;

export function local(url: string | null | undefined): string {
  if (!url) return "";
  return url.startsWith(ORIGIN) ? `/img/anilist/${url.slice(ORIGIN.length)}` : url;
}

// A cover in AniList's three widths, so the browser downloads the one the card needs: 100px for a
// thumbnail, 230px for a card on a normal screen, 460px on a retina one. `sizes` is how wide the
// image is drawn, in CSS pixels.
export function cover(url: string | null | undefined, sizes: string) {
  if (!url || !COVER.test(url)) return { src: local(url), srcset: undefined, sizes: undefined };
  const at = (size: string) => local(url.replace(COVER, `/cover/${size}/`));
  return {
    src: at("medium"),
    srcset: `${at("small")} 100w, ${at("medium")} 230w, ${at("large")} 460w`,
    sizes
  };
}
