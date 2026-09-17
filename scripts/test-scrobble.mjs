// The webhook reader decides which Jellyfin events mean "an episode was finished". Reading one
// wrongly either writes progress you did not earn (a paused episode, a scrub past the end) or
// ignores the ones you did. Pinned here without a network; the integration test covers the write.
// Run: npm test

const { finishedEpisode, parsePayload, TEMPLATE } = await import("../server/scrobble.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("reading the payload");

const ours = parsePayload({
  event: "PlaybackStop",
  itemType: "Episode",
  itemId: "ep-1",
  seriesId: "s-1",
  playedToCompletion: "True",
  userId: "u-1"
});
check("the template's own keys are read", ours.event === "PlaybackStop" && ours.itemId === "ep-1" && ours.seriesId === "s-1" && ours.userId === "u-1");
check("the plugin renders booleans as strings, which count", ours.playedToCompletion === true);

const theirs = parsePayload({
  NotificationType: "UserDataSaved",
  ItemType: "Episode",
  ItemId: "ep-2",
  SeriesId: "s-1",
  Played: true,
  SaveReason: "TogglePlayed",
  UserId: "u-1"
});
check("Send All Properties' PascalCase keys are read too", theirs.event === "UserDataSaved" && theirs.itemId === "ep-2" && theirs.played === true && theirs.saveReason === "TogglePlayed");

const empty = parsePayload({});
check("an empty body reads as nothing rather than throwing", empty.event === "" && empty.itemId === "" && empty.playedToCompletion === false);
check("a non-object body is tolerated", parsePayload(null).event === "" && parsePayload("x").itemId === "");

console.log("\nwhat counts as finishing an episode");

const done = extra => finishedEpisode(parsePayload({ itemType: "Episode", itemId: "e", seriesId: "s", ...extra }));
check("playback that ran to the end", done({ event: "PlaybackStop", playedToCompletion: "True" }) === true);
check("playback stopped early does not", done({ event: "PlaybackStop", playedToCompletion: "False" }) === false);
check("playback start does not", done({ event: "PlaybackStart", playedToCompletion: "True" }) === false);
check("marking played in Jellyfin counts", done({ event: "UserDataSaved", played: "True", saveReason: "TogglePlayed" }) === true);
check("a user-data save for another reason does not", done({ event: "UserDataSaved", played: "True", saveReason: "PlaybackProgress" }) === false);
check("marking unplayed does not", done({ event: "UserDataSaved", played: "False", saveReason: "TogglePlayed" }) === false);
check("a movie is not an episode", done({ event: "PlaybackStop", playedToCompletion: "True", itemType: "Movie" }) === false);
check("an unknown event is ignored", done({ event: "ItemAdded" }) === false);

console.log("\nthe template");

check("every template value is a plugin variable", Object.values(TEMPLATE).every(value => /^\{\{\w+\}\}$/.test(value)));
check("the template carries what the reader needs", ["event", "itemId", "seriesId", "playedToCompletion", "played", "saveReason", "userId"].every(key => key in TEMPLATE));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
