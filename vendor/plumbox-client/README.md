# @plumbox/client

Client SDK for **Plum Box**: connect a third-party app to the user's box through **Plum Relay** — no IP addresses, ports, or tunneling. Works like a cloud SDK, but the storage is the user's own box.

- Zero runtime dependencies, ESM + CJS, TypeScript types included
- Pluggable HTTP transport: global `fetch` (Node 18+/desktop) or Obsidian's `requestUrl` (desktop **and** mobile — no `isDesktopOnly`)
- **Third-party apps authenticate with delegated OAuth (PKCE): the user finds their box on plumbox.me and types the password only on that box's own page. Your app only ever receives a scoped, revocable token — never the password.**

## ⚠️ Read this first — never handle the user's password

If you are building a **third-party app** (anything not made by Plum), do **not** collect the user's Plum email + password in your app. Use the delegated flow below. It is the same model as "Sign in with Google":

- In the **system browser**, the user enters their email on `https://plumbox.me` and the code Plum mails them, picks their box, and types the password **only** on that box's own page (`https://pb-….plumbox.me`). plumbox.me itself never asks for the password.
- Your app gets back a scoped token it can store and revoke — never the password, never account control (`admin` is refused). With `files:app` it reaches only a folder the box makes for your app.

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
  scopes: ["files:app"],                       // subset of the client's registered scopes; "admin" is never granted
});
saveForLater(req.codeVerifier, req.state);
openInSystemBrowser(req.url);                   // user finds their box on plumbox.me, signs in on it & approves

// (2) Your redirect handler is called with myapp://plum/callback?code=…&iss=…&state=…
const cb = parseCallback(incomingUrl);          // checks iss: a code from anything but a Plum box is dropped
if (cb.error || !cb.code || !cb.iss) throw new Error(cb.error ?? "no code");

const tokens = await exchangeCode({
  baseUrl: cb.iss,                              // which box issued the code (app never knew the address)
  code: cb.code,
  state: cb.state,
  expectedState: savedState,                    // the SDK refuses a callback this sign-in did not start
  codeVerifier: savedVerifier,                  // PKCE: proves this is the same app that started the flow
  clientId: "com.example.myapp:ios",
  redirectUri: "myapp://plum/callback",
});
// Store ALL of `tokens` (accessToken, refreshToken, expiresAt, appFolder, scope)
// + cb.iss (as baseUrl). The password never touched your app.
```

Then use the box with the stored tokens. The client refreshes the hourly access token by itself; persist every new set it hands you:

```ts
const box = new PlumClient({
  baseUrl: iss,                                 // = cb.iss
  clientId: "com.example.myapp:ios",            // needed to refresh
  token: tokens.accessToken,
  refreshToken: tokens.refreshToken,            // absent from older boxes: the token then never expires
  expiresAt: tokens.expiresAt,
  appFolder: tokens.appFolder,
  onTokens: (next) => save(next),               // the old refresh token stops working — store the new one
  onAuthError: () => showReconnect(),           // the connection is gone (revoked, or 90 days unused)
});
const root = tokens.appFolder!;                 // e.g. "/Apps/My App" — a files:app token reaches nothing else
for await (const f of box.drive.listAll(root, { recursive: true, hash: true })) {
  console.log(f.path, f.hash ?? `(size=${f.size})`);
}
await box.drive.upload(`${root}/note.md`, "# hello", { overwrite: true });
```

### 🔒 Security requirements (do not skip)

These are the difference between "safe like Sign in with Google" and "you can still be phished":

1. **Open the authorization URL in the system browser, never an embedded webview.** An embedded webview lets *your own app* read what the user types, which defeats the entire point — the user must see the real `plumbox.me`, and then their own box's `pb-….plumbox.me`, in a browser address bar they trust. (This is RFC 8252 §8.12.) In Obsidian use `window.open(url)`; on desktop/Electron use `shell.openExternal(url)`; on mobile use the OS "open in browser" API.
2. **Exchange the code only with the box that issued it.** The callback's `iss` is that box's address. `parseCallback` and `exchangeCode` accept only a Plum box's canonical origin — `https://pb-….plumbox.me`, https, no port, no path, not the box's `-lan`/`-wan` alias — and stop with `invalid_iss` otherwise, before the code or the verifier is sent anywhere. Never pass some other `baseUrl` to `exchangeCode`. (`isPlumIssuer` exposes the same check.)
3. **Check `state`.** Pass the `state` `beginAuthorization` gave you as `expectedState`; `exchangeCode` stops with `invalid_state` when the callback's differs. A mismatch means a forged or stale callback.
4. **Request the least scope you need** (`files:read` alone if you never write). Never request `admin` — the box refuses it anyway.
5. **Store the tokens, not the password** (you never had the password). Treat them like a credential; let the user revoke them in box settings. Keep the refresh token **on one device**: it rotates on every use, so two devices sharing it (a synced settings file, a backup restored elsewhere) knock each other out — after a 60-second grace, a reused refresh token ends the connection.
6. **Register your client first.** The box consents only to a `client_id` it knows: one you registered in the [developer console](https://developer.plum.im) (Clients page of your app) or declared in your app's `manifest.json` `clients[]`. The consent screen shows the *registered* display name, and the `redirect_uri` and `scope` must match that registration — an unknown client gets `unauthorized_client` before any screen renders.

`parseCallback` accepts an error callback (`?error=access_denied&state=…`) without `iss`, since older boxes send none; when one is present it gets the same check. The `iss` check says "a Plum box", not "the box the user picked" — swapping in another Plum box is stopped by the signed box list on plumbox.me, which sends the user only to the box they chose.

`exchangeCode` stops with a `PlumOAuthError` (`code`: `invalid_iss`, `invalid_state`, `invalid_request`) before any request; errors from the box itself come as `PlumApiError`.

### Scopes

| scope | grants |
|---|---|
| `files:app` | read and write **one folder the box makes for your app** (`appFolder`, e.g. `/Apps/My App`) — nothing else of the drive, not the trash |
| `files:read` | read the user's files |
| `files:write` | change files (implies `files:read`) |
| `user:profile` | the signed-in user's profile only (`auth.me()`) |
| `service:call:<app_id>` | call that app's box-side service (`/apps/<app_id>/svc/*`) |

`read` / `write` are the older spellings and still work (`write` = `files:read` + `files:write`).

**`files:app`** is the least a sync or backup app needs, and what the user is most willing to approve. The token response's `appFolder` is the folder (an absolute drive path; the box creates it before it issues the token). Paths stay absolute drive paths inside it — `/Apps/My App/vault/note.md`. The token may list, download, view, archive, upload (also chunked), mkdir, rename, move, save, delete and use versions there; anything else, or any path outside the folder, is `403` (`PlumForbiddenError`). `drive.ensureDir` passes over the parents it may not touch (`/Apps`), so `ensureDir(appFolder + "/vault")` works.

### Token lifetime and refresh

A box issues an **access token that expires after an hour** and a **refresh token** with it (`exchangeCode` → `OAuthTokens`):

- Give `PlumClient` the whole set plus `clientId` and it keeps the access token fresh: it refreshes when less than a minute is left, and when a request comes back `401` it refreshes once and sends that request again. Concurrent requests share one refresh. Request bodies in this SDK are in-memory buffers, so the retry sends the same bytes; a `401` is answered before the box reads the body, so it is not a duplicate write. (A body that cannot be read twice is not retried: you get `PlumApiError` code `token_refreshed` with a fresh token in place — send it again.)
- Every refresh **rotates** the refresh token. `onTokens(tokens)` receives the new set before the request is retried — persist it, or use `tokenStorage`, which now stores the whole set as JSON (a bare token saved by 0.3 still loads).
- A refresh token lapses after **90 days** unused. When the box refuses one (`invalid_grant`: revoked, lapsed, reused) the connection is gone: requests fail with `PlumAuthError` code `invalid_grant` and `onAuthError` fires — once, however many requests were in flight. A refresh that merely failed to reach the box is a plain `PlumApiError`; the refresh token is still good.
- Refreshes go only to `<iss>/api/oauth/token`, the box the sign-in was checked against: `iss` defaults to `baseUrl`, and must pass `isPlumIssuer` (pass `iss` explicitly if you talk to the box at a LAN address).
- `refreshTokens({ iss, clientId, refreshToken })` does one refresh by hand; `client.refresh()` forces one.
- **Older boxes** answer the code exchange with an access token only, which never expires: no `refreshToken`, no `expiresAt`. Use it as before — the client never tries to refresh it.

**401 vs 403.** `401` (`PlumAuthError`) means the credential is no good — after the client could not cure it with a refresh, sign the user in again. `403` (`PlumForbiddenError`, since 0.4.0) means the credential is fine but may not do *this* (a scope it lacks, a path outside its app folder): it does not fire `onAuthError`, and reconnecting would not help.

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
import { beginAuthorization, callbackFromParams, exchangeCode, injectedAdapter, PlumClient } from "@plumbox/client";

const CLIENT_ID = "im.plum.obsidian-sync:obsidian";  // as registered in the developer console
const REDIRECT_URI = "obsidian://plum-sync";         // Obsidian routes it to the "plum-sync" handler

// In onload(): register the deep-link handler once.
this.registerObsidianProtocolHandler("plum-sync", async (params) => {
  const cb = callbackFromParams(params);              // same iss check as parseCallback
  if (cb.error || !cb.code || !cb.iss) return new Notice("Sign-in was cancelled.");
  const tokens = await exchangeCode({
    baseUrl: cb.iss,
    code: cb.code,
    state: cb.state,
    expectedState: this.pending.state,
    codeVerifier: this.pending.verifier,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    http: injectedAdapter(requestUrl),          // bypasses CORS on desktop AND mobile
  });
  // Per device, NOT data.json: data.json is often synced to the user's other
  // devices, and a rotating refresh token used from two devices ends the connection.
  this.app.saveLocalStorage("plum-sync-tokens", { iss: cb.iss, ...tokens });
  new Notice("Connected to your Plum Box.");
});

// When the user clicks "Connect":
const req = await beginAuthorization({
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scopes: ["files:app"],                        // the plugin's own folder: tokens.appFolder
});
this.pending = { verifier: req.codeVerifier, state: req.state };
window.open(req.url);   // system browser — plumbox.me finds the box; the password goes only to the box's own page

// Using it:
const t = this.app.loadLocalStorage("plum-sync-tokens");
const box = new PlumClient({
  baseUrl: t.iss,
  clientId: CLIENT_ID,
  token: t.accessToken,
  refreshToken: t.refreshToken,
  expiresAt: t.expiresAt,
  appFolder: t.appFolder,
  http: injectedAdapter(requestUrl),
  onTokens: (next) => this.app.saveLocalStorage("plum-sync-tokens", { ...t, ...next }),
});
```

`requestUrl` bypasses CORS on desktop and mobile, so the same code runs everywhere. `app.saveLocalStorage` keeps the tokens on this device for this vault (plaintext at rest, like most sync plugins); they are scoped and the user can revoke them, but never store `admin`.

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
| Tokens and the account | `refreshTokens` (one refresh by hand), `client.refresh()`, the `refreshToken`/`expiresAt`/`clientId`/`iss`/`onTokens` options, `appFolder`; `auth.createToken/listTokens/revokeToken/me/logout`, `setToken/loadToken/clearToken`. `login`/`verifyTotp` are deprecated. |
| Drive | `list`, `listAll` (auto-pagination), `download`, `upload` (auto-chunked >8 MiB, `overwrite` option), `mkdir`, `ensureDir`, `rename`, `move`, `remove` (→ trash), `trash.list/restore/empty`, `versions.list/restore` |
| Apps (companion) | `apps.status`, `apps.ensureServiceInstalled` (→ `plum://store/<id>` / web install link), `apps.entitlement`, `apps.refreshEntitlements` |
| Errors | `PlumApiError` (status/code), `PlumAuthError` (401, or a refused refresh `invalid_grant` → `onAuthError` hook), `PlumForbiddenError` (403: not allowed — no hook), `PlumOAuthError` (a callback the SDK refused before sending anything) |

## Environments

Production (`plumbox.me`) is the default and needs no option. Plum's own staging
environment is chosen with `boxDomain: "staging.plumbox.me"` — on `PlumClient`,
`beginAuthorization`, `parseCallback`/`callbackFromParams` (second argument) and
`exchangeCode`. Each environment takes only its own boxes: a production client
refuses a `*.staging.plumbox.me` box and a staging client refuses a production
one (LAN addresses and localhost belong to neither and are accepted).
`PRODUCTION`, `STAGING` and `plumEnvironment()` hold the addresses.

## Sync-client notes

- `list(..., { hash: true })` returns the box-indexed SHA-256 per file; files uploaded before hash indexing omit it — fall back to `size` + `modTime`.
- `upload(..., { overwrite: true })` replaces in place and the box snapshots the previous content as a version. Without it, name collisions create `name (2).ext`.
- `remove` moves to the box trash (user-recoverable), not a hard delete.
- Browser pages can NOT talk to a box cross-origin (the box API sends no CORS headers); use Node/desktop runtimes or Obsidian `requestUrl`.

## What changed

**0.4.0**

- Access tokens expire after an hour; `exchangeCode` returns `OAuthTokens` (`accessToken`, `tokenType`, `scope`, and from current boxes `refreshToken`, `expiresAt`, `appFolder`). The `accessToken` and `scope` you read before are where they were.
- `PlumClient` refreshes by itself given `refreshToken` + `clientId` (options `expiresAt`, `iss`, `appFolder`, `onTokens`; method `refresh()`); `refreshTokens()` for doing it by hand. `tokenStorage` stores the whole set as JSON.
- New scope `files:app`: one folder the box makes for the app (`appFolder`). `drive.ensureDir` passes over parents a token may not touch.
- **Breaking:** a 403 is now `PlumForbiddenError` (a `PlumApiError`), not `PlumAuthError`, and does not fire `onAuthError`. If you caught `PlumAuthError` to handle "not allowed", catch `PlumForbiddenError`.
- `onAuthError` fires once per dead credential rather than once per failed request.

**0.3.0** — the `iss`/`state` checks on the OAuth callback and the code exchange; environments (`boxDomain`).

## Integration tests

```bash
PLUM_INTEGRATION=1 \
PLUM_TEST_BASE_URL=https://pb-<sub>.plumbox.me \
PLUM_TEST_PAT=plum_pat_... \
npm run test:integration --workspace @plumbox/client
```
