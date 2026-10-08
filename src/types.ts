// Persisted plugin data. Stored via Obsidian's plugin data.json.
//
// SECURITY: `token` is a scoped (read/write) Personal Access Token, never the
// password — during the OAuth flow the user finds their box on plumbox.me and
// types the password only on that box's own page. It is at rest in data.json
// like most sync plugins; the user can revoke it in box settings at any time.
// We never request or store an `admin` token.

export interface FileSnapshot {
  /** SHA-256 (hex) of the file content at last successful sync. */
  hash: string;
  /** Local mtime (ms) at last sync — lets us skip re-hashing unchanged files. */
  mtime: number;
}

export interface PlumSyncSettings {
  /** Box origin that issued the token, e.g. https://pb-<sub>.plumbox.me. */
  baseUrl: string;
  /** Scoped PAT (plum_pat_…). Empty when not connected. */
  token: string;
  /** Which box account this token belongs to (display only). */
  account: string;

  /** Remote drive folder the vault maps to, e.g. /Obsidian/<vault>. */
  remoteRoot: string;
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
  remoteRoot: "",
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
export const CLIENT_ID = "im.plum.obsidian-sync:obsidian";
export const CLIENT_NAME = "Obsidian Plum Sync";
export const REDIRECT_URI = "obsidian://plum-sync";
/** Read and write files — never `admin`; the box refuses it anyway. */
export const SCOPES = ["files:read", "files:write"] as const;
