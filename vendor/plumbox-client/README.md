# @plumbox/client

Client SDK for **Plum Box**: connect a third-party app to the user's box through **Plum Relay** — no IP addresses, ports, or tunneling. Works like a cloud SDK, but the storage is the user's own box.

- Zero runtime dependencies, ESM + CJS, TypeScript types included
- Pluggable HTTP transport: global `fetch` (Node 18+/desktop) or Obsidian's `requestUrl` (desktop **and** mobile — no `isDesktopOnly`)
- **Third-party apps authenticate with delegated OAuth (PKCE): the user finds their box on plumbox.me and types the password only on that box's own page. Your app only ever receives a scoped, revocable token — never the password.**

## ⚠️ Read this first — never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do **not** collect the user's Plum email + password in your app. Use the delegated flow below. It is the same model as "Sign in with Google":

- In the **system browser**, the user enters their email on `https://plumbox.me` and the code Plum mails them, picks their box, and types the password **only** on that box's own page (`https://pb-….plumbox.me`). plumbox.me itself never asks for the password.
- Your app gets back a scoped **read/write** token it can store and revoke — never the password, never account control (`admin` is refused).

`client.login({ login, password })` further down is **deprecated**: it has your app handle the password, and a Plum Box v3 box can ask a new device for a mail code that it cannot answer.

## Quickstart (third-party app — delegated OAuth)

Two steps: (1) send the user to Plum to authorize; (2) trade the returned code for a token.

```ts
import { beginAuthorization, exchangeCode, parseCallback, PlumClient } from "@plumbox/client";

// (1) Start authorization. Open the URL in the SYSTEM BROWSER — not an
//     in-app webview (see the security note below). Keep verifier + state.
const req = await beginAuthorization({
  clientId: "com.example.myapp:ios",          // registered in the Plum developer console (or your manifest's clients[])
  redirectUri: "myapp://plum/callback",        // must be one of the client's registered redirect URIs
  scopes: ["files:read", "files:write"],       // subset of the client's registered scopes; "admin" is never granted
});
saveForLater(req.codeVerifier, req.state);
openInSystemBrowser(req.url);                   // user finds their box on plumbox.me, signs in on it & approves

// (2) Your redirect handler is called with myapp://plum/callback?code=…&iss=…&state=…
const cb = parseCallback(incomingUrl);          // checks iss: a code from anything but a Plum box is dropped
if (cb.error || !cb.code || !cb.iss) throw new Error(cb.error ?? "no code");

const { accessToken, scope } = await exchangeCode({
  baseUrl: cb.iss,                              // which box issued the code (app never knew the address)
  code: cb.code,
  state: cb.state,
  expectedState: savedState,                    // the SDK refuses a callback this sign-in did not start
  codeVerifier: savedVerifier,                  // PKCE: proves this is the same app that started the flow
  clientId: "com.example.myapp:ios",
  redirectUri: "myapp://plum/callback",
});
// Store accessToken + cb.iss (as baseUrl). The password never touched your app.
```

Then use the box with the stored token:

```ts
const box = new PlumClient({ baseUrl /* = cb.iss */, token: accessToken });
for await (const f of box.drive.listAll("/", { recursive: true, hash: true })) {
  console.log(f.path, f.hash ?? `(size=${f.size})`);
}
await box.drive.upload("/MyApp/note.md", "# hello", { overwrite: true });
```

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded webview.** An embedded webview lets *your own app* read what the user types, which defeats the entire point — the user must see the real `plumbox.me`, and then their own box's `pb-….plumbox.me`, in a browser address bar they trust. (This is RFC 8252 §8.12.) In Obsidian use `window.open(url)`; on desktop/Electron use `shell.openExternal(url)`; on mobile use the OS "open in browser" API.
2. **Exchange the code only with the box that issued it.** The callback's `iss` is that box's address. `parseCallback` and `exchangeCode` accept only a Plum box's canonical origin — `https://pb-….plumbox.me`, https, no port, no path, not the box's `-lan`/`-wan` alias — and stop with `invalid_iss` otherwise, before the code or the verifier is sent anywhere. Never pass some other `baseUrl` to `exchangeCode`. (`isPlumIssuer` exposes the same check.)
3. **Check `state`.** Pass the `state` `beginAuthorization` gave you as `expectedState`; `exchangeCode` stops with `invalid_state` when the callback's differs. A mismatch means a forged or stale callback.
4. **Request the least scope you need** (`files:read` alone if you never write). Never request `admin` — the box refuses it anyway.
5. **Store the token, not the password** (you never had the password). Treat the token like a credential; let the user revoke it in box settings.
6. **Register your client first.** The box consents only to a `client_id` it knows: one you registered in the [developer console](https://developer.plum.im) (Clients page of your app) or declared in your app's `manifest.json` `clients[]`. The consent screen shows the *registered* display name, and the `redirect_uri` and `scope` must match that registration — an unknown client gets `unauthorized_client` before any screen renders.

`parseCallback` accepts an error callback (`?error=access_denied&state=…`) without `iss`, since older boxes send none; when one is present it gets the same check. The `iss` check says "a Plum box", not "the box the user picked" — swapping in another Plum box is stopped by the signed box list on plumbox.me, which sends the user only to the box they chose.

`exchangeCode` stops with a `PlumOAuthError` (`code`: `invalid_iss`, `invalid_state`, `invalid_request`) before any request; errors from the box itself come as `PlumApiError`.

### Scopes

| scope | grants |
|---|---|
| `files:read` | read the user's files |
| `files:write` | change files (implies `files:read`) |
| `user:profile` | the signed-in user's profile only |
| `service:call:<app_id>` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` are the older spellings and still work (`write` = `files:read` + `files:write`).

## Companion apps: the box-side service and paid features

A companion app usually pairs with a service (.plu) running on the box. After connecting:

```ts
const box = new PlumClient({ baseUrl, token });
const svc = await box.apps.ensureServiceInstalled("com.example.myapp");
if (!svc.installed) {
  // Send the user to install it: the Plum app (deep link) or the box web UI.
  openUrl(svc.installUrl /* plum://store/com.example.myapp */ ?? svc.webUrl);
}
const ent = await box.apps.entitlement("com.example.myapp");
const pro = ent.skus.some((s) => s.sku === "pro" && s.active);   // what "pro" unlocks is up to you
```

Your box-side service sees the same information on every proxied request as `X-Plum-Entitlements: pro,plus` (and `X-Plum-Entitlements-Stale: 1` when the box could not refresh receipts for two days), and through the control socket `GET /entitlement`.

## Obsidian plugin (delegated OAuth)

```ts
import { requestUrl, Notice } from "obsidian";
import { beginAuthorization, callbackFromParams, exchangeCode, injectedAdapter } from "@plumbox/client";

const CLIENT_ID = "im.plum.obsidian-sync:obsidian";  // as registered in the developer console
const REDIRECT_URI = "obsidian://plum-sync";         // Obsidian routes it to the "plum-sync" handler

// In onload(): register the deep-link handler once.
this.registerObsidianProtocolHandler("plum-sync", async (params) => {
  const cb = callbackFromParams(params);              // same iss check as parseCallback
  if (cb.error || !cb.code || !cb.iss) return new Notice("Sign-in was cancelled.");
  const { accessToken } = await exchangeCode({
    baseUrl: cb.iss,
    code: cb.code,
    state: cb.state,
    expectedState: this.pending.state,
    codeVerifier: this.pending.verifier,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    http: injectedAdapter(requestUrl),          // bypasses CORS on desktop AND mobile
  });
  await this.saveData({ baseUrl: cb.iss, token: accessToken });
  new Notice("Connected to your Plum Box.");
});

// When the user clicks "Connect":
const req = await beginAuthorization({
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scopes: ["files:read", "files:write"],
});
this.pending = { verifier: req.codeVerifier, state: req.state };
window.open(req.url);   // system browser — plumbox.me finds the box; the password goes only to the box's own page
```

`requestUrl` bypasses CORS on desktop and mobile, so the same code runs everywhere. Note the token is stored in the plugin's `data.json` (plaintext at rest, like most sync plugins) — it is scoped read/write and the user can revoke it, but never store `admin`.

## Deprecated: password login and box lookup

Plum Box v3 moves every sign-in onto the box's own page, reached through plumbox.me with a mailed code. Three older routes remain for now and are deprecated:

- **`client.login({ login, password })`** (and `verifyTotp`) — your app handles the password. On a v3 box a new device may be asked for a mail code, which this method cannot answer: it stops with `PlumApiError` code `second_factor_unsupported`. Use the delegated flow above.
- **`discover(email)`** — the relay's old `/api/lookup`, an existence oracle that v3 switches off. It goes away in a later minor version. The OAuth callback's `iss` already names the box.
- **`resolveBoxes(email, password)` from `@plumbox/oprf`** — OPRF discovery ends with v3 as well; that package gets no new releases.

## API surface

| Area | Methods |
|---|---|
| **Delegated auth (third-party)** | **`beginAuthorization`**, **`parseCallback`** / **`callbackFromParams`**, **`exchangeCode`** — the password-free OAuth+PKCE flow; `isPlumIssuer` (the `iss` check) |
| Box address | the callback's `iss` — no lookup needed. `discover(email)` is deprecated. |
| Tokens and the account | `auth.createToken/listTokens/revokeToken/me/logout`, `setToken/loadToken/clearToken`. `login`/`verifyTotp` are deprecated. |
| Drive | `list`, `listAll` (auto-pagination), `download`, `upload` (auto-chunked >8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash), `trash.list/restore/empty`, `versions.list/restore` |
| Apps (companion) | `apps.status`, `apps.ensureServiceInstalled` (→ `plum://store/<id>` / web install link), `apps.entitlement`, `apps.refreshEntitlements` |
| Errors | `PlumApiError` (status/code), `PlumAuthError` (401/403 → `onAuthError` hook), `PlumOAuthError` (a callback the SDK refused before sending anything) |

## Sync-client notes

- `list(..., { hash: true })` returns the box-indexed SHA-256 per file; files uploaded before hash indexing omit it — fall back to `size` + `modTime`.
- `upload(..., { overwrite: true })` replaces in place and the box snapshots the previous content as a version. Without it, name collisions create `name (2).ext`.
- `remove` moves to the box trash (user-recoverable), not a hard delete.
- Browser pages can NOT talk to a box cross-origin (the box API sends no CORS headers); use Node/desktop runtimes or Obsidian `requestUrl`.

## Integration tests

```bash
PLUM_INTEGRATION=1 \
PLUM_TEST_BASE_URL=https://pb-<sub>.plumbox.me \
PLUM_TEST_PAT=plum_pat_... \
npm run test:integration --workspace @plumbox/client
```
