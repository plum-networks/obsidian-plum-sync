import { Plugin, type ObsidianProtocolData } from "obsidian";
import type { PlumClient } from "@plumbox/client";
import { DEFAULT_SETTINGS, type Connection, type PlumSyncSettings } from "./types.js";
import { PlumSyncSettingTab } from "./settings-tab.js";
import { SyncEngine } from "./sync/engine.js";
import { completeConnect, connectionEnded, http, isConnected } from "./plum.js";
import { forgetUncheckedBox } from "./connect.js";
import {
  activeConnection,
  ConnectionStore,
  openClient,
  remoteRootFor,
  saveRotatedTokens,
  type ActiveConnection,
} from "./connection.js";

const CHANGE_DEBOUNCE_MS = 8000;

export default class PlumSyncPlugin extends Plugin {
  settings!: PlumSyncSettings;
  engine!: SyncEngine;
  /** This device's connection (per-vault local storage; data.json only on old Obsidian). */
  store!: ConnectionStore;

  /**
   * One client per connection, shared by every sync: the SDK refreshes the
   * access token once for all requests in flight, which only works if they go
   * through the same client. A second client would refresh with a refresh
   * token the first one already rotated away.
   */
  private client: PlumClient | null = null;
  private clientFor: string | null = null;

  private autoSyncTimer: number | null = null;
  private changeTimer: number | null = null;

  async onload(): Promise<void> {
    this.store = new ConnectionStore(
      this.app,
      () => this.settings,
      () => this.saveSettings(),
    );
    await this.loadSettings();
    this.engine = new SyncEngine(this);

    // Deep link back from the box after sign-in: obsidian://plum-sync?code=&iss=&state=
    this.registerObsidianProtocolHandler("plum-sync", async (params: ObsidianProtocolData) => {
      const ok = await completeConnect(this, params);
      if (ok && this.settings.syncOnChange) void this.engine.run();
    });

    this.addRibbonIcon("refresh-cw", "Plum: sync now", async () => {
      await this.engine.run();
    });

    this.addCommand({
      id: "plum-sync-now",
      name: "Sync now",
      callback: async () => {
        await this.engine.run();
      },
    });

    this.addSettingTab(new PlumSyncSettingTab(this.app, this));

    this.registerAutoSyncOnChange();
    this.rescheduleAutoSync();

    // A gentle sync shortly after startup if connected.
    if (isConnected(this)) {
      this.registerInterval(window.setTimeout(() => void this.engine.run(), 4000));
    }
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
    if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Never carry a half-finished OAuth request across reloads.
    this.settings.pending = this.settings.pending ?? null;
    // A connection 0.1 saved from an unchecked iss is dropped: reconnect.
    if (forgetUncheckedBox(this.settings)) await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** The connection this device uses, or null when not connected. */
  connection(): ActiveConnection | null {
    return activeConnection(this.store, this.settings);
  }

  /** The client for the current connection (the same one until it changes). */
  getClient(): PlumClient | null {
    const conn = this.connection();
    if (!conn) {
      this.client = this.clientFor = null;
      return null;
    }
    if (this.client && this.clientFor === conn.id) return this.client;
    this.client = openClient(conn, {
      http,
      saveTokens: (id, tokens) => saveRotatedTokens(this.store, id, tokens),
      ended: (c, err) => void connectionEnded(this, c, err),
    });
    this.clientFor = conn.id;
    return this.client;
  }

  /** The drive folder this vault syncs to (an app-folder connection: <appFolder>/<vault>). */
  remoteRoot(conn: ActiveConnection | null = this.connection()): string {
    return remoteRootFor(conn, this.settings, this.app.vault.getName());
  }

  /**
   * Adopt a new sign-in as this device's connection. It replaces a 0.2-era
   * token in data.json: that one is shared by every device the vault syncs to,
   * and each of them now connects once on its own.
   */
  async setConnection(conn: Connection): Promise<void> {
    this.client = this.clientFor = null;
    await this.store.save(conn);
    if (this.settings.token) {
      this.settings.token = "";
      this.settings.account = "";
      this.settings.baseUrl = "";
      await this.saveSettings();
    }
  }

  /** Record the account name of connection `id`, if it is still the current one. */
  async updateAccount(id: string, account: string): Promise<void> {
    const stored = this.store.load();
    if (stored && stored.id === id) await this.store.save({ ...stored, account });
  }

  /**
   * Forget `conn` if it is still the one in use (not a newer sign-in made
   * meanwhile). Returns true when it did.
   */
  async dropConnection(conn: ActiveConnection): Promise<boolean> {
    if (this.clientFor === conn.id) this.client = this.clientFor = null;
    if (conn.kind === "legacy") {
      if (this.settings.token !== conn.accessToken) return false;
      this.settings.token = "";
      this.settings.account = "";
      await this.saveSettings();
      return true;
    }
    const stored = this.store.load();
    if (!stored || stored.id !== conn.id) return false;
    await this.store.save(null);
    return true;
  }

  /** Disconnect this device (the user's choice in settings). */
  async disconnect(): Promise<void> {
    const conn = this.connection();
    if (conn) await this.dropConnection(conn);
  }

  /** (Re)arm the interval timer from the current settings. */
  rescheduleAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const mins = this.settings.syncIntervalMin;
    if (mins > 0) {
      this.autoSyncTimer = window.setInterval(
        () => {
          if (isConnected(this) && !this.engine.isRunning) void this.engine.run();
        },
        mins * 60 * 1000,
      );
      this.registerInterval(this.autoSyncTimer);
    }
  }

  /** Debounced sync after vault edits. */
  private registerAutoSyncOnChange(): void {
    const bump = () => {
      if (!this.settings.syncOnChange || !isConnected(this)) return;
      if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
      this.changeTimer = window.setTimeout(() => {
        if (!this.engine.isRunning) void this.engine.run();
      }, CHANGE_DEBOUNCE_MS);
    };
    this.registerEvent(this.app.vault.on("modify", bump));
    this.registerEvent(this.app.vault.on("create", bump));
    this.registerEvent(this.app.vault.on("delete", bump));
    this.registerEvent(this.app.vault.on("rename", bump));
  }
}
