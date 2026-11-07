import { isFakeRelease } from "../server/guard.js";

// The guard removes and blocklists downloads on its own, so what counts as fake is tested directly.
// Run: npm test

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};
const f = (name, size = 1.4e9, priority = 1) => ({ name, size, priority });

console.log("fake releases");
check("a lone executable named like an episode is fake (VisionQuest)",
  isFakeRelease([f("VisionQuest S01E05 Firewall 1080p WEB H264-MeGusta.exe", 2e6, 0)]).fake);
check("a double extension is still an executable", isFakeRelease([f("Show.S01E01.1080p.mkv.exe", 3e6)]).fake);
check("an executable with a tiny clip to look real is fake",
  isFakeRelease([f("Show.S01E01.mp4", 12e6), f("Codec Installer.exe", 2e6), f("readme.txt", 1e3)]).fake);
check("a shortcut file counts", isFakeRelease([f("Show S01E01 1080p.lnk", 2e3)]).fake);
check("the reason names the file", /\.exe/.test(isFakeRelease([f("Show S01E02.exe", 2e6)]).reason));

check("a bare zip in place of an episode is fake (SubsPlease never zips)",
  isFakeRelease([f("[SubsPlease] Kusuriya no Hitorigoto - S03E06 [1080p WEBRip AV1].zip", 1341.8e6)]).fake);
check("so is a 7z or an iso", isFakeRelease([f("Show.S01E01.7z")]).fake && isFakeRelease([f("Show.S01E01.iso")]).fake);

console.log("real releases");
check("a normal episode is not fake", !isFakeRelease([f("Show.S01E01.1080p.WEB-DL.mkv")]).fake);
check("an episode with subtitles and an nfo is not fake",
  !isFakeRelease([f("Show.S01E01.mkv"), f("Show.S01E01.en.srt", 5e4), f("Show.nfo", 2e3)]).fake);
check("a real episode next to a stray executable is left to the user, not removed",
  !isFakeRelease([f("Show.S01E01.1080p.mkv"), f("Torrent downloaded from site.exe", 1e5)]).fake);
check("a season pack is not fake", !isFakeRelease(Array.from({ length: 8 }, (_, i) => f(`Show.S01E0${i + 1}.mkv`))).fake);
check("a release with a real video and a bonus zip is kept", !isFakeRelease([f("Show.S01E01.mkv"), f("extras.zip", 3e8)]).fake);
check("a RAR scene release is not called fake", !isFakeRelease([f("show.s01e01.rar", 5e8), f("show.s01e01.r00", 5e8)]).fake);
check("a magnet without its file list yet is not judged", !isFakeRelease([]).fake && !isFakeRelease(undefined).fake);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
