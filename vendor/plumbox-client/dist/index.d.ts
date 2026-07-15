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

interface PlumClientOptions {
    /** `https://pb-<sub>.plumbox.me` — from {@link discover} or stored settings. */
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
 * @deprecated Use `resolveBoxes(email, password)` from `@plumbox/oprf` instead.
 *
 * This resolves a box from an email alone via the relay's LEGACY `/api/lookup`.
 * That endpoint is an existence oracle — anyone who guesses an email learns
 * whether that person owns a box and its address — and it is being retired. The
 * zero-knowledge path (`@plumbox/oprf`) requires the password too, so the relay
 * never learns the email, the password, or which box. Prefer it for anything
 * new; this remains only for boxes/relays that predate the routing directory.
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
 * apps. The user authenticates on the Plum portal — NEVER inside your app — and
 * your app receives only a scoped, revocable token, never the password.
 *
 * Two halves:
 *   1. `beginAuthorization()` builds the portal URL + a PKCE verifier. Open the
 *      URL in the system browser; the user logs in and approves; the portal
 *      redirects back to your `redirectUri` with `?code=…&state=…`.
 *   2. `exchangeCode()` swaps that code (+ the verifier) for the access token at
 *      the box's token endpoint.
 *
 * Obsidian: register `obsidian://<your-id>/callback` via
 * `registerObsidianProtocolHandler`, pass it as `redirectUri`, and pass
 * `injectedAdapter(requestUrl)` as `http`.
 */
declare const DEFAULT_PORTAL_URL = "https://plumbox.me";
interface BeginAuthorizationOptions {
    clientId: string;
    clientName: string;
    redirectUri: string;
    scopes: TokenScope[];
    /** Portal that hosts the /authorize consent page. */
    portalUrl?: string;
}
interface AuthorizationRequest {
    /** Open this in the system browser. */
    url: string;
    /** Keep until the redirect returns; needed to exchange the code. */
    codeVerifier: string;
    /** Opaque value echoed back in the redirect — verify it to prevent CSRF. */
    state: string;
}
interface ExchangeCodeOptions {
    /**
     * The box base URL to exchange the code against, e.g.
     * https://pb-<sub>.plumbox.me. Read it from the callback's `iss` param
     * (see `parseCallback`) — your app never learned the box address by itself,
     * which is the whole point of routing auth through the portal.
     */
    baseUrl: string;
    code: string;
    codeVerifier: string;
    clientId: string;
    redirectUri: string;
    http?: HttpAdapter;
}
interface CallbackResult {
    code?: string;
    state?: string;
    /** The box origin that issued the code — pass as `baseUrl` to exchangeCode. */
    iss?: string;
    /** Present when the user denied or the box refused (e.g. "access_denied"). */
    error?: string;
}
/**
 * Parse the redirect the box sent back to your `redirect_uri`
 * (e.g. obsidian://plum-sync/callback?code=…&state=…&iss=…). Verify
 * `state === <the state from beginAuthorization>` yourself before exchanging —
 * a mismatch means a forged callback. Throws on a malformed URL.
 */
declare function parseCallback(callbackUrl: string): CallbackResult;
/**
 * Build the portal authorization URL and the PKCE material. The verifier and
 * `state` must survive until the redirect comes back.
 */
declare function beginAuthorization(opts: BeginAuthorizationOptions): Promise<AuthorizationRequest>;
/**
 * Exchange the authorization code for a scoped access token (PAT). Verify the
 * returned `state` matches what `beginAuthorization` produced BEFORE calling
 * this. Returns the token to store — the password was never seen by your app.
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

export { AuthApi, type AuthorizationRequest, type BeginAuthorizationOptions, type CallbackResult, type CreatedToken, DEFAULT_PORTAL_URL, DEFAULT_RELAY_URL, type DiscoverResult, DriveApi, type DriveEntry, type ExchangeCodeOptions, type FileVersion, type HttpAdapter, type HttpRequest, type HttpResponse, type ListOptions, type LoginNeedsTotp, type LoginOk, type LoginResult, PlumApiError, PlumAuthError, PlumClient, type PlumClientOptions, type RequestUrlLike, type TokenInfo, type TokenScope, type TokenStorage, type TrashEntry, type UploadOptions, beginAuthorization, discover, exchangeCode, fetchAdapter, injectedAdapter, parseCallback };
