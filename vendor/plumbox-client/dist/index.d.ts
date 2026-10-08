/** Error thrown for any non-2xx API response. */
declare class PlumApiError extends Error {
    readonly status: number;
    /** Machine-readable code when the server provided one (e.g. "version_mismatch"). */
    readonly code?: string;
    constructor(status: number, message: string, code?: string);
}
/** 401/403: missing, expired, or revoked credential. Triggers `onAuthError`. */
declare class PlumAuthError extends PlumApiError {
    constructor(status: number, message: string, code?: string);
}
/**
 * A sign-in the SDK stopped on its own, before anything was sent: the
 * redirect back from the box did not hold up. `code` says why:
 *
 * - `invalid_iss`: the callback named no box, or something that is not a Plum
 *   box's own address (`https://pb-….plumbox.me`). The authorization code is
 *   never sent anywhere.
 * - `invalid_state`: the callback's `state` is not the one this sign-in began
 *   with (a forged or stale redirect).
 * - `invalid_request`: no code and no error, or a required value is missing.
 */
declare class PlumOAuthError extends Error {
    readonly code: "invalid_iss" | "invalid_state" | "invalid_request";
    constructor(code: PlumOAuthError["code"], message: string);
}

/**
 * Transport abstraction. The SDK never talks to the network directly — it
 * builds {@link HttpRequest}s and hands them to an {@link HttpAdapter}. This
 * keeps the core runtime-agnostic: Node/browser use {@link fetchAdapter},
 * Obsidian plugins inject `requestUrl` via `injectedAdapter` (which bypasses
 * CORS on both desktop and mobile).
 */
interface HttpRequest {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | Uint8Array;
}
interface HttpResponse {
    status: number;
    /** Lower-cased header names. `set-cookie` must be preserved when available. */
    headers: Record<string, string>;
    body: ArrayBuffer;
}
interface HttpAdapter {
    request(req: HttpRequest): Promise<HttpResponse>;
}

/** One entry from `drive.list` / `drive.listAll`. */
interface DriveEntry {
    name: string;
    path: string;
    isDir: boolean;
    size: number;
    /** RFC 3339 timestamp as reported by the box. */
    modTime: string;
    /**
     * SHA-256 of file content — present only when requested with `hash: true`
     * AND the file has been indexed by the box (files uploaded before hash
     * indexing simply omit it; fall back to size+modTime comparison).
     */
    hash?: string;
}
interface TokenInfo {
    id: string;
    userId: string;
    name: string;
    tokenPrefix: string;
    scopes: string[];
    createdAt: string;
    lastUsedAt?: string;
    expiresAt?: string;
}
interface CreatedToken extends TokenInfo {
    /** Plaintext PAT (`plum_pat_…`) — returned exactly once at creation. */
    token: string;
}
interface TrashEntry {
    id: string;
    [key: string]: unknown;
}
interface FileVersion {
    id: string;
    version_no?: number;
    [key: string]: unknown;
}
type TokenScope = "read" | "write" | "admin";
/**
 * Scopes a registered companion app may ask the box owner for (OAuth). One
 * vocabulary on every surface — the developer console's client registration,
 * the box's consent screen and the token it mints:
 *
 * - `files:read`   read the user's files
 * - `files:write`  change files (implies files:read)
 * - `user:profile` read the signed-in user's profile only
 * - `service:call:<app_id>` call that app's box-side service
 *
 * `read` / `write` are the older spellings and still work (`write` =
 * files:read + files:write). `admin` is never delegated to an app.
 */
type OAuthScope = "files:read" | "files:write" | "user:profile" | `service:call:${string}` | "read" | "write";
/** GET /api/apps/{id}/status — the app's box-side service, when it has one. */
interface AppServiceStatus {
    state: string;
    [key: string]: unknown;
}
/** One SKU of an app's entitlement view. */
interface SkuEntitlement {
    sku: string;
    kind: string;
    /** RFC 3339, or "" when the entitlement never expires. */
    expires_at: string;
    active: boolean;
}
/** GET /api/apps/{id}/entitlement — the store receipts this box holds for the app. */
interface AppEntitlement {
    skus: SkuEntitlement[];
    /** When the box last refreshed its receipts from the store ("" = never). */
    refreshed_at: string;
    /** True when the box could not refresh for two days; apps decide how strict to be. */
    stale: boolean;
}
/** Result of `client.apps.ensureServiceInstalled()`. */
type EnsureServiceResult = {
    installed: true;
    status: AppServiceStatus;
} | {
    installed: false;
    /** Deep link that opens the Plum app on the store page for this app. */
    installUrl: string;
    /** The box's own web UI, for a device without the Plum app. */
    webUrl: string;
};
interface TokenStorage {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
}
interface ListOptions {
    /** Include every descendant (flat), not just direct children. */
    recursive?: boolean;
    /** Include indexed SHA-256 content hashes. */
    hash?: boolean;
    /** Server-side filename/path search. */
    q?: string;
    limit?: number;
    offset?: number;
    sort?: "name" | "size" | "modified" | "type" | "path";
    order?: "asc" | "desc";
}
interface UploadOptions {
    /**
     * Replace the file at the exact name (previous content is kept as a
     * version snapshot on the box). Without it, a name collision creates
     * "name (2).ext" — NOT what a sync client wants.
     */
    overwrite?: boolean;
    contentType?: string;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
}

interface ListPage {
    items: DriveEntry[];
    total: number;
    limit: number;
    offset: number;
}
declare class DriveApi {
    private client;
    constructor(client: PlumClient);
    /** List one page. Pass limit/offset for pagination; see `listAll` for iteration. */
    list(path: string, opts?: ListOptions): Promise<ListPage>;
    /** Iterate every entry under `path`, transparently walking pages. */
    listAll(path: string, opts?: Omit<ListOptions, "limit" | "offset">): AsyncGenerator<DriveEntry, void, void>;
    download(path: string): Promise<ArrayBuffer>;
    /**
     * Upload `data` as the file at `path` (full drive path including filename).
     * Small files go as one multipart POST; larger ones use the resumable
     * chunked protocol automatically. With `overwrite: true` the file is
     * replaced in place (previous content becomes a version snapshot) — without
     * it a name collision creates "name (2).ext".
     */
    upload(path: string, data: ArrayBuffer | Uint8Array | string, opts?: UploadOptions): Promise<DriveEntry>;
    private uploadChunked;
    /** Create one directory. Parent must exist — see `ensureDir` for mkdir -p. */
    mkdir(path: string): Promise<void>;
    /** mkdir -p: create every missing segment of `path`. */
    ensureDir(path: string): Promise<void>;
    /** Rename within the same directory. For cross-directory moves use `move`. */
    rename(path: string, newName: string): Promise<void>;
    /** Move a file or directory to an arbitrary path (destination parent must exist). */
    move(path: string, newPath: string): Promise<void>;
    /** Delete (moves to the box trash — recoverable from the Drive UI). */
    remove(path: string): Promise<void>;
    readonly trash: {
        list: () => Promise<TrashEntry[]>;
        restore: (id: string) => Promise<void>;
        empty: () => Promise<void>;
    };
    readonly versions: {
        list: (path: string) => Promise<FileVersion[]>;
        restore: (path: string, versionId: string) => Promise<void>;
    };
}

/**
 * App-platform calls a companion app makes against the box: is my box-side
 * service installed, and which paid features (SKUs) does this box hold.
 *
 * A companion app never installs anything itself — the box owner confirms an
 * install in the Plum app. `ensureServiceInstalled` tells you whether the
 * service is there and, when it is not, where to send the user.
 */
declare class AppsApi {
    private client;
    constructor(client: PlumClient);
    /**
     * GET /api/apps/{appId}/status — the runtime state of the app's box-side
     * service. Throws a PlumApiError with status 404 when the app is not
     * installed for this user (or has no service).
     */
    status(appId: string): Promise<AppServiceStatus>;
    /**
     * Check that the app's service is installed on the box; if it is not,
     * return the links that take the user to install it: `installUrl` opens
     * the Plum app on the store page (`plum://store/<appId>`), `webUrl` opens
     * the box's own web UI for a device without the Plum app. Installation is
     * confirmed by the owner there; afterwards the Plum app returns to your
     * registered redirect URI.
     */
    ensureServiceInstalled(appId: string): Promise<EnsureServiceResult>;
    /**
     * GET /api/apps/{appId}/entitlement — the store receipts this box holds for
     * the app, as the box verified them. Works before the service is
     * installed. Needs a session or a token with `service:call:<appId>` (or a
     * read scope). What a SKU unlocks is up to your app; the box only proves
     * the receipt.
     */
    entitlement(appId: string): Promise<AppEntitlement>;
    /**
     * POST /api/apps/entitlements/refresh — ask the box to fetch its receipts
     * from the store now (right after a purchase). Returns how many receipts
     * the box now holds.
     */
    refreshEntitlements(): Promise<number>;
}

interface PlumClientOptions {
    /** `https://pb-<sub>.plumbox.me` — the `iss` of an OAuth callback, or stored settings. */
    baseUrl: string;
    /** PAT (`plum_pat_…`). When set, every request uses Bearer auth. */
    token?: string;
    /** Transport. Defaults to global-fetch. Obsidian: `injectedAdapter(requestUrl)`. */
    http?: HttpAdapter;
    /** Optional persistence for the PAT (key: "plumbox.token"). */
    tokenStorage?: TokenStorage;
    /** Called once per auth failure (revoked/expired credential) — hook your re-login UI here. */
    onAuthError?: (err: PlumAuthError) => void;
}
interface LoginOk {
    ok: true;
    requireTotp?: undefined;
}
interface LoginNeedsTotp {
    ok: false;
    requireTotp: true;
    /** Complete the 2nd factor; resolves once the session is established. */
    verifyTotp(code: string): Promise<LoginOk>;
}
type LoginResult = LoginOk | LoginNeedsTotp;
declare class PlumClient {
    readonly baseUrl: string;
    readonly drive: DriveApi;
    readonly auth: AuthApi;
    readonly apps: AppsApi;
    private http;
    private token?;
    private sessionCookie;
    private tokenStorage?;
    private onAuthError?;
    constructor(opts: PlumClientOptions);
    /** Load a previously stored PAT from tokenStorage. Returns true when found. */
    loadToken(): Promise<boolean>;
    /** Adopt a PAT for all subsequent requests (and persist it when storage is configured). */
    setToken(token: string): Promise<void>;
    clearToken(): Promise<void>;
    get hasToken(): boolean;
    get hasSession(): boolean;
    /**
     * First-factor login with the box account's email/username + password.
     * On success the client holds a session cookie (7-day TTL) — immediately
     * mint a PAT with `auth.createToken` and persist only that.
     *
     * @deprecated Connect with delegated OAuth instead (`beginAuthorization` →
     * `parseCallback` → `exchangeCode`), so the password is typed only on the
     * box's own page. A Plum Box v3 box can answer a sign-in from a new device
     * with a mail code (`requireSecondFactor`); this method cannot complete that
     * step and stops with `PlumApiError` code `second_factor_unsupported`.
     */
    login(cred: {
        login: string;
        password: string;
    }): Promise<LoginResult>;
    private captureSession;
    /** Internal: perform an API request with auth + error mapping. */
    request(path: string, opts?: {
        method?: string;
        json?: unknown;
        body?: string | ArrayBuffer | Uint8Array;
        headers?: Record<string, string>;
        allowStatus?: number[];
    }): Promise<HttpResponse>;
}
declare class AuthApi {
    private client;
    constructor(client: PlumClient);
    /**
     * Mint a Personal Access Token. Requires a live session (call `login`
     * first). Store `result.token` — it is shown exactly once. Prefer scopes
     * `["read","write"]`; never request `admin` from an app.
     */
    createToken(opts: {
        name: string;
        scopes: TokenScope[];
        expiresInDays?: number;
    }): Promise<CreatedToken>;
    listTokens(): Promise<TokenInfo[]>;
    revokeToken(id: string): Promise<void>;
    /** Who does the current credential belong to? Also a cheap connectivity check. */
    me(): Promise<{
        id: string;
        username?: string;
        email?: string;
        displayName?: string;
    }>;
    /** Discard the box-side session (call after minting a PAT). */
    logout(): Promise<void>;
}

declare const DEFAULT_RELAY_URL = "https://relay.plumbox.me";
interface DiscoverResult {
    /** e.g. "pb-0123abcd…" */
    subdomain: string;
    /** Ready-to-use base URL: `https://<subdomain>.plumbox.me` */
    baseUrl: string;
}
/**
 * @deprecated Connect with delegated OAuth instead (`beginAuthorization` →
 * `parseCallback` → `exchangeCode`): the callback's `iss` names the user's
 * box, so an app never has to look one up. This function goes away in a later
 * minor version, when the relay switches `/api/lookup` off.
 *
 * This resolves a box from an email alone via the relay's LEGACY `/api/lookup`.
 * That endpoint is an existence oracle — anyone who guesses an email learns
 * whether that person owns a box and its address — and Plum Box v3 retires it:
 * people now find their boxes on plumbox.me with a code mailed to them. The
 * other old route, `resolveBoxes` from `@plumbox/oprf`, is deprecated for the
 * same reason.
 *
 * CACHE THE RESULT: the endpoint is rate-limited to ~10 requests/minute per
 * source IP, and a box's subdomain is stable for its lifetime.
 */
declare function discover(email: string, opts?: {
    relayUrl?: string;
    http?: HttpAdapter;
}): Promise<DiscoverResult>;

/**
 * Delegated authorization (OAuth 2.0 Authorization Code + PKCE) for third-party
 * apps. The user finds their box on plumbox.me (their email and a code Plum
 * mails them) and types the password only on that box's own page — NEVER
 * inside your app. Your app receives a scoped, revocable token, never the
 * password.
 *
 * Two halves:
 *   1. `beginAuthorization()` builds the authorization URL + a PKCE verifier.
 *      Open the URL in the system browser; the user picks their box, signs in
 *      there and approves; the box redirects back to your `redirectUri` with
 *      `?code=…&state=…&iss=…`.
 *   2. `parseCallback()` reads that redirect and checks `iss`;
 *      `exchangeCode()` swaps the code (+ the verifier) for the access token at
 *      that box — and only at that box.
 *
 * Obsidian: register a protocol handler via `registerObsidianProtocolHandler`,
 * pass its URL as `redirectUri`, read the params with `callbackFromParams`, and
 * pass `injectedAdapter(requestUrl)` as `http`.
 */
declare const DEFAULT_PORTAL_URL = "https://plumbox.me";
/**
 * The shape of every Plum box's own address, as `iss` (v3 contract 10.1). A
 * box answers an authorization with its canonical origin. Its LAN and WAN
 * aliases (`pb-…-lan`, `pb-…-wan`) are refused on top of this pattern by
 * {@link isPlumIssuer}. The name is not narrowed to hex: older box names exist.
 */
declare const PLUM_ISSUER_PATTERN: RegExp;
/**
 * Whether `iss` is a Plum box's canonical origin: `https://pb-<name>.plumbox.me`
 * exactly — https, no port, no path, no trailing slash, lower case, and not the
 * box's `-lan`/`-wan` alias.
 *
 * Limit: this says "a Plum box", not "the box the user picked". Swapping in a
 * different Plum box is stopped elsewhere (the signed directory list and the
 * portal sending the user only to the box they chose).
 */
declare function isPlumIssuer(iss: unknown): iss is string;
interface BeginAuthorizationOptions {
    /**
     * The client id you registered for this app in the Plum developer console
     * (`<app_id>:<label>`, e.g. `com.example.notes:ios`), or declared in your
     * app's manifest `clients[]`. The box refuses an unregistered client_id
     * with `unauthorized_client` before showing any consent screen.
     */
    clientId: string;
    /**
     * @deprecated The consent screen shows the display name from the client
     * registration; this value is ignored by boxes that know the registry. Kept
     * for older boxes, still sent when provided.
     */
    clientName?: string;
    /** Must equal one of the redirect URIs registered for the client (loopback http: any port). */
    redirectUri: string;
    /** Must be a subset of the scopes the client was registered with. */
    scopes: OAuthScope[];
    /** Portal that hosts the /authorize entry (where the user finds their box). */
    portalUrl?: string;
}
interface AuthorizationRequest {
    /** Open this in the system browser. */
    url: string;
    /** Keep until the redirect returns; needed to exchange the code. */
    codeVerifier: string;
    /** Keep until the redirect returns; pass it to `exchangeCode` as `expectedState`. */
    state: string;
}
interface ExchangeCodeOptions {
    /**
     * The box to exchange the code at: the callback's `iss` (from
     * `parseCallback`/`callbackFromParams`). It must be a Plum box's canonical
     * origin ({@link isPlumIssuer}); anything else stops with
     * `PlumOAuthError("invalid_iss")` before the code or the verifier is sent
     * anywhere. The code goes to `<iss>/api/oauth/token` and nowhere else.
     */
    baseUrl: string;
    code: string;
    /** The callback's `state`. */
    state?: string;
    /**
     * The `state` that `beginAuthorization` returned for this sign-in. A callback
     * whose `state` is different (or missing) stops with
     * `PlumOAuthError("invalid_state")` before anything is sent.
     */
    expectedState: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
    http?: HttpAdapter;
}
interface CallbackResult {
    /** Present only when the callback also carried a valid `iss`. */
    code?: string;
    state?: string;
    /**
     * The box that issued the code, already checked with {@link isPlumIssuer} —
     * pass it to `exchangeCode` as `baseUrl` and keep it as the box's address.
     * Absent when the callback carried none (an error callback from an older
     * box) or one that failed the check.
     */
    iss?: string;
    /**
     * Set when there is nothing to exchange: the box's own error (e.g.
     * "access_denied"), "invalid_iss" when the callback's `iss` is missing or
     * not a Plum box (the code is then dropped), or "invalid_request" when the
     * callback carried neither a code nor an error.
     */
    error?: string;
}
/**
 * Read the redirect the box sent back to your `redirect_uri`
 * (e.g. myapp://plum/callback?code=…&state=…&iss=…) and check its `iss`
 * (v3 contract 10.1):
 *
 * - A code with no `iss`, or with one that is not a Plum box's own address,
 *   comes back as `{ error: "invalid_iss" }` and WITHOUT the code — there is
 *   nothing left to send anywhere.
 * - An error callback is accepted without `iss` (older boxes send none); if it
 *   carries one, the same check applies.
 *
 * `state` is checked by `exchangeCode` (pass the one `beginAuthorization`
 * returned as `expectedState`). Throws on a malformed URL.
 */
declare function parseCallback(callbackUrl: string): CallbackResult;
/**
 * {@link parseCallback} for callbacks that arrive as a parameter object
 * rather than a URL — Obsidian's `registerObsidianProtocolHandler` hands the
 * handler `{ action, code, state, iss, … }`. Same checks, same result.
 */
declare function callbackFromParams(params: Record<string, unknown>): CallbackResult;
/**
 * Build the authorization URL and the PKCE material. The verifier and
 * `state` must survive until the redirect comes back.
 */
declare function beginAuthorization(opts: BeginAuthorizationOptions): Promise<AuthorizationRequest>;
/**
 * Exchange the authorization code for a scoped access token (PAT) at the box
 * that issued it. Before anything is sent, `baseUrl` must be a Plum box's own
 * address (`invalid_iss` otherwise) and the callback's `state` must equal
 * `expectedState` (`invalid_state` otherwise) — both as `PlumOAuthError`.
 * Returns the token to store; the password was never seen by your app.
 *
 * Errors from the box carry its OAuth code in `PlumApiError.code`:
 * `invalid_grant` (code used, expired or PKCE mismatch), `unauthorized_client`
 * (client_id not registered), `invalid_scope`, `invalid_redirect_uri`.
 */
declare function exchangeCode(opts: ExchangeCodeOptions): Promise<{
    accessToken: string;
    scope: string;
}>;

/**
 * Default adapter for runtimes with a global `fetch` (Node 18+, browsers,
 * Electron). Note: in browsers, cross-origin calls to a box are blocked by
 * CORS (the box API sends no CORS headers) and `Set-Cookie` is unreadable —
 * use this adapter from Node/desktop apps, and `injectedAdapter` inside
 * Obsidian.
 */
declare const fetchAdapter: HttpAdapter;

/**
 * Shape of Obsidian's `requestUrl` — declared structurally so this package
 * has no dependency on the `obsidian` module.
 */
interface RequestUrlLike {
    (options: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string | ArrayBuffer;
        contentType?: string;
        throw?: boolean;
    }): Promise<{
        status: number;
        headers: Record<string, string>;
        arrayBuffer: ArrayBuffer;
    }>;
}
/**
 * Adapter for Obsidian plugins:
 *
 * ```ts
 * import { requestUrl } from "obsidian";
 * const client = new PlumClient({ baseUrl, token, http: injectedAdapter(requestUrl) });
 * ```
 *
 * `requestUrl` bypasses CORS on desktop AND mobile, so the SDK works without
 * `isDesktopOnly`.
 */
declare function injectedAdapter(requestUrl: RequestUrlLike): HttpAdapter;

export { type AppEntitlement, type AppServiceStatus, AppsApi, AuthApi, type AuthorizationRequest, type BeginAuthorizationOptions, type CallbackResult, type CreatedToken, DEFAULT_PORTAL_URL, DEFAULT_RELAY_URL, type DiscoverResult, DriveApi, type DriveEntry, type EnsureServiceResult, type ExchangeCodeOptions, type FileVersion, type HttpAdapter, type HttpRequest, type HttpResponse, type ListOptions, type LoginNeedsTotp, type LoginOk, type LoginResult, type OAuthScope, PLUM_ISSUER_PATTERN, PlumApiError, PlumAuthError, PlumClient, type PlumClientOptions, PlumOAuthError, type RequestUrlLike, type SkuEntitlement, type TokenInfo, type TokenScope, type TokenStorage, type TrashEntry, type UploadOptions, beginAuthorization, callbackFromParams, discover, exchangeCode, fetchAdapter, injectedAdapter, isPlumIssuer, parseCallback };
