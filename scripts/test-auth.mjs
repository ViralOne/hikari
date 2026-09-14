import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A forged session cookie is a full bypass of the login, so the token format is tested directly:
// signature, expiry, revocation, and the cookie flags that keep it out of JavaScript's reach.
// No services and no Jellyfin needed. Run: npm test

process.env.AUTH_FILE = join(mkdtempSync(join(tmpdir(), "hikari-auth-")), "auth.json");
process.env.AUTH_SESSION_DAYS = "7";

const auth = await import("../server/auth.js");

let failures = 0;
const check = (name, pass, detail) => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `: ${detail}` : ""}`);
  if (!pass) failures += 1;
};

console.log("session tokens");

const created = auth.load();
const secret = JSON.parse(readFileSync(process.env.AUTH_FILE, "utf8")).secret;

check("a signing key is generated on first run", created.created === true && secret.length >= 32, `${secret.length} chars`);

// issue() is internal, so a token is built the same way the server does: sign a payload with the
// key that was just persisted.
const b64 = value => Buffer.from(value).toString("base64url");
const mint = claims => {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
};
const future = Math.floor(Date.now() / 1000) + 3600;
const valid = mint({ u: "milu", id: "abc", admin: true, g: 1, exp: future });

const session = auth.verify(valid);
check("a correctly signed token verifies", session?.name === "milu" && session?.admin === true);

check("a token signed with another key is rejected", auth.verify(`${valid.split(".")[0]}.${"x".repeat(43)}`) === null);

// Swapping the claims without re-signing is the obvious attack: promote yourself to admin.
const tampered = `${b64(JSON.stringify({ u: "milu", id: "abc", admin: true, g: 1, exp: future + 99999 }))}.${valid.split(".")[1]}`;
check("editing the claims invalidates the signature", auth.verify(tampered) === null);

check("an expired token is rejected", auth.verify(mint({ u: "milu", id: "abc", g: 1, exp: Math.floor(Date.now() / 1000) - 1 })) === null);
check("a token with no signature is rejected", auth.verify("just-a-payload") === null);
check("an empty token is rejected", auth.verify("") === null && auth.verify(null) === null);
check("a token from another generation is rejected", auth.verify(mint({ u: "milu", id: "abc", g: 99, exp: future })) === null);

// Sign out everywhere has to invalidate a session that is otherwise still perfectly valid.
check("the token is still good before revocation", auth.verify(valid) !== null);
const generation = auth.revokeAll();
check("revokeAll invalidates existing tokens", generation === 2 && auth.verify(valid) === null);

console.log("\ncookies");

const cookie = auth.cookieHeader("token-value", { secure: false });
check("the cookie is HttpOnly", cookie.includes("HttpOnly"));
check("the cookie is SameSite=Lax so links from Homepage still work", cookie.includes("SameSite=Lax"));
check("Secure is only set when asked", !cookie.includes("Secure") && auth.cookieHeader("t", { secure: true }).includes("Secure"));
check("the cookie carries the configured lifetime", cookie.includes(`Max-Age=${7 * 24 * 60 * 60}`));
check("clearing sets an immediate expiry", auth.clearCookieHeader({ secure: false }).includes("Max-Age=0"));

check("the session cookie is found among others", auth.readCookie("other=1; hikari_session=abc.def; another=2") === "abc.def");
check("a missing cookie reads as null", auth.readCookie("other=1") === null && auth.readCookie(undefined) === null);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures > 0 ? 1 : 0);
