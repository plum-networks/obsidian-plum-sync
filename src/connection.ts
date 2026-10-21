// Where this device keeps its connection to the box, which connection is in
// use, and the PlumClient built from it. No Obsidian imports, so it can be
// tested without Obsidian; plum.ts and main.ts wire it up.
import {
  isPlumIssuer,
  PlumClient,
  type HttpAdapter,
  type OAuthTokens,
  type PlumAuthError,
} from "@plumbox/client";
import { CLIENT_ID, type Connection, type PlumSyncSettings } from "./types.js";

/** Key of the connection in Obsidian's per-vault local storage. */
export const CONNECTION_KEY = "plum-sync-connection";

/** Obsidian's `App` local-storage methods (1.8.7+): per vault, per device. */
export interface DeviceStorage {
  loadLocalStorage?(key: string): unknown;
  saveLocalStorage?(key: string, data: unknown | null): void;
}

/** Read a stored connection, or null when it is not one we wrote. */
function asConnection(v: unknown): Connection | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Partial<Connection>;
  if (typeof c.iss !== "string" || !isPlumIssuer(c.iss)) return null;
  if (typeof c.accessToken !== "string" || !c.accessToken) return null;
  const out: Connection = {
    id: typeof c.id === "string" && c.id ? c.id : `stored:${c.accessToken.slice(-8)}`,
    iss: c.iss,
    accessToken: c.accessToken,
    scope: typeof c.scope === "string" ? c.scope : "",
    account: typeof c.account === "string" ? c.account : "",
  };
  if (typeof c.refreshToken === "string" && c.refreshToken) out.refreshToken = c.refreshToken;
  if (typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt)) out.expiresAt = c.expiresAt;
  if (typeof c.appFolder === "string" && c.appFolder.startsWith("/")) out.appFolder = c.appFolder;
  return out;
}

/**
 * This device's connection. With Obsidian's per-vault local storage (1.8.7+)
 * it lives there and never in data.json, which is often synced to the user's
 * other devices — a rotating refresh token used from two devices ends the
 * connection. Older Obsidian has no such storage; there it falls back to
 * data.json (`settings.connection`).
 */
export class ConnectionStore {
  constructor(
    private readonly app: DeviceStorage,
    private readonly settings: () => PlumSyncSettings,
    private readonly saveSettings: () => Promise<void>,
  ) {}

  /** True when the connection stays on this device. */
  get deviceLocal(): boolean {
    return typeof this.app.loadLocalStorage === "function" && typeof this.app.saveLocalStorage === "function";
  }

  load(): Connection | null {
    if (this.deviceLocal) {
      let raw: unknown = this.app.loadLocalStorage!(CONNECTION_KEY);
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          raw = null;
        }
      }
      return asConnection(raw);
    }
    return asConnection(this.settings().connection);
  }

  async save(c: Connection | null): Promise<void> {
    if (this.deviceLocal) {
      this.app.saveLocalStorage!(CONNECTION_KEY, c);
      return;
    }
    this.settings().connection = c;
    await this.saveSettings();
  }
}

/** The connection in use: this device's own, or a 0.2-era token from data.json. */
export interface ActiveConnection extends Connection {
  /** "own": this device's connection. "legacy": data.json's never-expiring token. */
  kind: "own" | "legacy";
}

/**
 * Which connection this device uses. Its own wins. Otherwise a token 0.2 saved
 * in data.json keeps working as it is — it never expires and has no refresh
 * token, so sharing it between devices is harmless.
 */
export function activeConnection(store: ConnectionStore, settings: PlumSyncSettings): ActiveConnection | null {
  const own = store.load();
  if (own) return { ...own, kind: "own" };
  if (settings.token && isPlumIssuer(settings.baseUrl)) {
    return {
      kind: "legacy",
      id: `legacy:${settings.token.slice(-8)}`,
      iss: settings.baseUrl,
      accessToken: settings.token,
      scope: "",
      account: settings.account,
    };
  }
  return null;
}

function randomId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A new connection from a finished sign-in. */
export function connectionFromTokens(iss: string, tokens: OAuthTokens): Connection {
  const c: Connection = {
    id: randomId(),
    iss,
    accessToken: tokens.accessToken,
    scope: tokens.scope,
    account: "",
  };
  if (tokens.refreshToken) c.refreshToken = tokens.refreshToken;
  if (tokens.expiresAt !== undefined) c.expiresAt = tokens.expiresAt;
  if (tokens.appFolder) c.appFolder = tokens.appFolder;
  return c;
}

/** Whether `scope` (space-separated) grants `want`. */
export function hasScope(scope: string, want: string): boolean {
  return scope.split(/\s+/).includes(want);
}

/**
 * Whether to ask the box who the account is (auth.me needs user:profile).
 * A connection that does not say what it was granted (a 0.2 token) is asked
 * as before; a failure there is harmless.
 */
export function mayReadProfile(c: Connection): boolean {
  return !c.scope || hasScope(c.scope, "user:profile") || hasScope(c.scope, "read") || hasScope(c.scope, "write");
}

/**
 * The drive folder the vault syncs to. A connection with an app folder always
 * uses <appFolder>/<vault> — its token reaches nothing outside that folder, so
 * the remote-folder setting does not apply. Other connections keep the
 * setting, default /Obsidian/<vault>.
 */
export function remoteRootFor(c: Connection | null, settings: PlumSyncSettings, vaultName: string): string {
  if (c?.appFolder) return `${c.appFolder.replace(/\/+$/, "")}/${vaultName}`;
  return settings.remoteRoot || `/Obsidian/${vaultName}`;
}

/**
 * Save a refresh's new tokens into the stored connection they belong to. Not
 * when that connection is gone (disconnected) or replaced by a newer sign-in
 * meanwhile: those must not be overwritten or brought back.
 */
export async function saveRotatedTokens(store: ConnectionStore, id: string, t: OAuthTokens): Promise<void> {
  const stored = store.load();
  if (!stored || stored.id !== id) return;
  const next: Connection = {
    ...stored,
    accessToken: t.accessToken,
    scope: t.scope || stored.scope,
  };
  if (t.refreshToken) next.refreshToken = t.refreshToken;
  else delete next.refreshToken;
  if (t.expiresAt !== undefined) next.expiresAt = t.expiresAt;
  else delete next.expiresAt;
  if (t.appFolder) next.appFolder = t.appFolder;
  await store.save(next);
}

export interface ClientHooks {
  http: HttpAdapter;
  /** Persist a refresh's new tokens for connection `id` (see saveRotatedTokens). */
  saveTokens(id: string, tokens: OAuthTokens): Promise<void>;
  /** The connection is over: refresh refused, or a token without one rejected. */
  ended(c: ActiveConnection, err: PlumAuthError): void;
}

/**
 * The PlumClient for a connection. It refreshes the hourly access token by
 * itself — once for all requests in flight — and every new token set is
 * saved straight away, because the refresh token it replaces stops working.
 * `ended` is called only when refreshing cannot help (once); a 403 (not
 * allowed, connection fine) never ends anything.
 */
export function openClient(c: ActiveConnection, hooks: ClientHooks): PlumClient {
  return new PlumClient({
    baseUrl: c.iss,
    token: c.accessToken,
    refreshToken: c.refreshToken,
    expiresAt: c.expiresAt,
    appFolder: c.appFolder,
    clientId: CLIENT_ID,
    http: hooks.http,
    onTokens: (t: OAuthTokens) => hooks.saveTokens(c.id, t),
    onAuthError: (err) => hooks.ended(c, err),
  });
}
