import { createSignal, Show } from "solid-js";
import { login } from "../api";

// Credentials go straight to Jellyfin and never reach anything Hikari stores. The form keeps
// them in component state only for as long as the request takes.
export function Login(props: { configured: boolean; onSignedIn: () => Promise<boolean> }) {
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username(), password());
      setPassword("");
      // Jellyfin can accept the password while the browser refuses the cookie, in which case the
      // form used to sit there having apparently done nothing at all.
      if (!(await props.onSignedIn())) {
        setError(
          "Jellyfin accepted that password, but the browser did not keep the session cookie. Check that cookies are allowed for this address, and if a proxy terminates HTTPS, that it forwards X-Forwarded-Proto."
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="login">
      <form class="login-card" onSubmit={submit}>
        <div class="brand-mark large" />
        <h1 class="setup-title">Sign in</h1>
        <p class="setup-lede">Use your Jellyfin username and password.</p>

        {/* The gate refuses every request when there is no Jellyfin to ask, so say that here rather
            than letting someone type a password into a form that cannot possibly work. */}
        <Show when={!props.configured}>
          <div class="notice bad" role="status">
            Login is switched on, but Jellyfin is not configured, so nobody can sign in. Remove the{" "}
            <code>auth</code> block from <code>/cache/hikari-settings.json</code> and restart to open Hikari again.
          </div>
        </Show>

        <Show when={error()}>
          {message => (
            <div class="notice bad" role="status" aria-live="polite">
              {message()}
            </div>
          )}
        </Show>

        <label class="setup-label" for="login-user">
          Username
        </label>
        <input
          id="login-user"
          class="field"
          autocomplete="username"
          autocapitalize="none"
          spellcheck={false}
          value={username()}
          onInput={event => setUsername(event.currentTarget.value)}
        />

        <label class="setup-label" for="login-pass">
          Password
        </label>
        <input
          id="login-pass"
          class="field"
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={event => setPassword(event.currentTarget.value)}
        />

        <button class="btn primary" type="submit" disabled={busy() || !username()}>
          {busy() ? "Checking…" : "Sign in"}
        </button>

        <p class="setup-foot">
          Hikari has no accounts of its own. Jellyfin checks the password, and Hikari only stores a
          signed session cookie.
        </p>
      </form>
    </div>
  );
}
