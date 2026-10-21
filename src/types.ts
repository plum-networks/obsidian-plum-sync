// Persisted plugin data. Stored via Obsidian's plugin data.json.
//
// data.json lives in the vault's .obsidian folder, and people often sync that
// folder between their devices. So the connection to the box is NOT kept here:
// its refresh token rotates on every use, and two devices refreshing the same
// one would end the connection for both. Each device keeps its own connection
// in Obsidian's per-vault local storage (see connection.ts) and signs in once.
//
// SECURITY: tokens are scoped (the plugin's own app folder), never the password
// — during the OAuth flow the user finds their box on plumbox.me and types the
// password only on that box's own page. They are at rest in plaintext like
// most sync plugins'; the user can revoke them in box settings at any time. We
// never request or store an `admin` token.

export interface FileSnapshot {
  /** SHA-256 (hex) of the file content at last successful sync. */
  hash: string;
  /** Local mtime (ms) at last sync — lets us skip re-hashing unchanged files. */
  mtime: number;
}

/**
 * One device's connection to the box: what the box's token endpoint returned
 * plus where it came from. Kept per device (connection.ts).
 */
export interface Connection {
  /** Random, per sign-in: tells this connection from a newer one. */
  id: string;
  /** The box that issued the tokens — a checked iss, https://pb-<name>.plumbox.me. */
  iss: string;
  accessToken: string;
  /** Rotates on every refresh. Absent from a box that issues never-expiring tokens. */
  refreshToken?: string;
  /** When accessToken expires (ms epoch, this device's clock). */
  expiresAt?: number;
  /** The folder a files:app token may use, e.g. /Apps/Obsidian Sync. */
  appFolder?: string;
  /** Granted scopes, space-separated. */
  scope: string;
  /** Which box account this is (display only). */
  account: string;
}

export interface PlumSyncSettings {
  /**
   * LEGACY (0.2 and earlier): the box of the never-expiring token below. New
   * connections are kept per device and never write it.
   */
  baseUrl: string;
  /**
   * LEGACY: a never-expiring PAT saved by 0.2. It keeps working as it is
   * until it is revoked or the user disconnects; a device with its own
   * connection uses that instead.
   */
  token: string;
  /** LEGACY: which box account `token` belongs to (display only). */
  account: string;
  /**
   * Only on Obsidian before 1.8.7, which has no per-vault local storage: the
   * connection, kept here as a last resort. Ignored where local storage exists.
   */
  connection: Connection | null;

  /**
   * Remote drive folder the vault maps to for a LEGACY connection, e.g.
   * /Obsidian/<vault>. A connection with an app folder always uses
   * <appFolder>/<vault> instead.
   */
  remoteRoot: string;
  /**
   * The remote folder `base` describes. When the folder in use differs (a new
   * kind of connection, or the setting changed), `base` starts empty, so the
   * other folder's history is never read as "deleted on the box".
   */
  baseRoot: string;
  /** Auto-sync interval in minutes; 0 disables the timer. */
  syncIntervalMin: number;
  /** Sync automatically shortly after the vault changes. */
  syncOnChange: boolean;

  /** 3-way sync base: path → snapshot at last successful sync. */
  base: Record<string, FileSnapshot>;
  /** Last successful sync (ms epoch); 0 if never. */
  lastSync: number;

  /** In-flight OAuth request state (verifier+state), cleared after callback. */
  pending: { verifier: string; state: string } | null;
}

export const DEFAULT_SETTINGS: PlumSyncSettings = {
  baseUrl: "",
  token: "",
  account: "",
  connection: null,
  remoteRoot: "",
  baseRoot: "",
  syncIntervalMin: 15,
  syncOnChange: true,
  base: {},
  lastSync: 0,
  pending: null,
};

// Fixed client identity for this plugin. A box consents only to a client its
// registry knows, and a registered client_id is "<app_id>:<label>" (core
// internal/oauth/registry.go, internal/apps/manifest.go: app id
// [a-z0-9][a-z0-9._-]{0,127}, label [a-z0-9-]{1,32}). This one is registered in
// the Plum store with REDIRECT_URI and SCOPES; the consent screen shows the
// registered name, so CLIENT_NAME only reaches boxes from before the registry.
// The registration must list every scope in SCOPES (scopes_allowed).
export const CLIENT_ID = "im.plum.obsidian-sync:obsidian";
export const CLIENT_NAME = "Obsidian Plum Sync";
export const REDIRECT_URI = "obsidian://plum-sync";
/**
 * files:app — only the folder the box makes for this plugin (the token's
 * appFolder), nothing else of the drive. user:profile — the account name the
 * settings show (auth.me). Never `admin`; the box refuses it anyway.
 */
export const SCOPES = ["files:app", "user:profile"] as const;
