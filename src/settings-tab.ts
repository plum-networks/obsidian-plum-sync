import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type PlumSyncPlugin from "./main.js";
import { startConnect } from "./plum.js";

export class PlumSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: PlumSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // --- Connection --------------------------------------------------------
    const conn = this.plugin.connection();
    const connected = conn !== null;
    new Setting(containerEl).setName("Connection").setHeading();

    const status = new Setting(containerEl).setName(
      connected ? "Connected" : "Not connected",
    );
    if (conn) {
      const who = conn.account ? ` as ${conn.account}` : "";
      const where =
        conn.kind === "legacy"
          ? "Connected by an earlier version of this plugin, for every device this vault syncs to. Connect again to give this device its own connection, limited to the plugin's own folder."
          : this.plugin.store.deviceLocal
            ? "This device's own connection — each device you use connects once."
            : "Update Obsidian to keep this connection on this device only.";
      status.setDesc(`Signed in${who} · ${conn.iss}. ${where}`);
      if (conn.kind === "legacy") {
        status.addButton((b) =>
          b.setButtonText("Connect again").onClick(async () => {
            await startConnect(this.plugin);
          }),
        );
      }
      status.addButton((b) =>
        b
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            await this.plugin.disconnect();
            new Notice("Plum: disconnected this device. You can also remove the plugin's access in your box settings.");
            this.display();
          }),
      );
    } else {
      status.setDesc(
        "Your browser opens plumbox.me to find your Plum Box, and you type your password only on your box's own page. This plugin never sees it — it gets access to its own folder on your box, which you can take back in your box settings. Each device you use connects once.",
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

    const remote = new Setting(containerEl).setName("Remote folder");
    if (conn?.appFolder) {
      // The token reaches only its app folder, so the folder is not a choice.
      remote.setDesc(`Your box gave this plugin its own folder. This vault syncs to ${this.plugin.remoteRoot(conn)}.`);
    } else if (conn) {
      remote.setDesc("Drive folder this vault maps to on your box.").addText((t) =>
        t
          .setPlaceholder(this.plugin.engine.defaultRoot())
          .setValue(this.plugin.settings.remoteRoot)
          .onChange(async (v) => {
            this.plugin.settings.remoteRoot = v.trim();
            await this.plugin.saveSettings();
          }),
      );
    } else {
      remote.setDesc("Your box gives this plugin its own folder when you connect; the vault syncs to a folder with its name in there.");
    }

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
