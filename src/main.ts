import { Plugin, type ObsidianProtocolData } from "obsidian";
import { DEFAULT_SETTINGS, type PlumSyncSettings } from "./types.js";
import { PlumSyncSettingTab } from "./settings-tab.js";
import { SyncEngine } from "./sync/engine.js";
import { completeConnect, isConnected } from "./plum.js";
import { parseCallback } from "@plumbox/client";

const CHANGE_DEBOUNCE_MS = 8000;

export default class PlumSyncPlugin extends Plugin {
  settings!: PlumSyncSettings;
  engine!: SyncEngine;

  private autoSyncTimer: number | null = null;
  private changeTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.engine = new SyncEngine(this);

    // Deep link back from the plumbox.me sign-in: obsidian://plum-sync?code=&iss=&state=
    this.registerObsidianProtocolHandler("plum-sync", async (params: ObsidianProtocolData) => {
      const cb = parseCallback(
        "obsidian://plum-sync?" + new URLSearchParams(params as Record<string, string>).toString(),
      );
      const ok = await completeConnect(this, cb);
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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
