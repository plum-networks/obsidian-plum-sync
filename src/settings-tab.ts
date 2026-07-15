import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type PlumSyncPlugin from "./main.js";
import { startConnect, isConnected } from "./plum.js";

export class PlumSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PlumSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Connection --------------------------------------------------------
    const connected = isConnected(this.plugin);
    new Setting(containerEl).setName("Connection").setHeading();

    const status = new Setting(containerEl).setName(
      connected ? "Connected" : "Not connected",
    );
    if (connected) {
      status.setDesc(
        `Signed in${this.plugin.settings.account ? ` as ${this.plugin.settings.account}` : ""} · ${this.plugin.settings.baseUrl}`,
      );
      status.addButton((b) =>
        b
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.token = "";
            this.plugin.settings.account = "";
            await this.plugin.saveSettings();
            new Notice("Plum: disconnected. Your token can also be revoked in box settings.");
            this.display();
          }),
      );
    } else {
      status.setDesc(
        "You'll sign in on plumbox.me in your browser. This plugin never sees your password — only a scoped token you can revoke.",
      );
      status.addButton((b) =>
        b
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            await startConnect(this.plugin);
          }),
      );
    }

    // --- Sync --------------------------------------------------------------
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Remote folder")
      .setDesc("Drive folder this vault maps to on your box.")
      .addText((t) =>
        t
          .setPlaceholder(this.plugin.engine.defaultRoot())
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (v) => {
            this.plugin.settings.remoteRoot = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync interval")
      .setDesc("Minutes between automatic syncs. 0 turns the timer off.")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.syncIntervalMin))
          .onChange(async (v) => {
            const n = Math.max(0, Math.floor(Number(v) || 0));
            this.plugin.settings.syncIntervalMin = n;
            await this.plugin.saveSettings();
            this.plugin.rescheduleAutoSync();
          }),
      );

    new Setting(containerEl)
      .setName("Sync after changes")
      .setDesc("Sync automatically a few seconds after you edit the vault.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnChange).onChange(async (v) => {
          this.plugin.settings.syncOnChange = v;
          await this.plugin.saveSettings();
        }),
      );

    const lastSync = this.plugin.settings.lastSync
      ? new Date(this.plugin.settings.lastSync).toLocaleString()
      : "never";
    new Setting(containerEl)
      .setName("Sync now")
      .setDesc(`Last sync: ${lastSync}`)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setDisabled(!connected)
          .onClick(async () => {
            await this.plugin.engine.run();
            this.display();
          }),
      );
  }
}
