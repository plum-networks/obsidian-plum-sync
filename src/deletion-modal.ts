import { App, Modal, Setting } from "obsidian";
import type { DeletionSide } from "./sync/engine.js";

export type DeletionChoice = "delete" | "keep" | null;

const PREVIEW = 10;

/**
 * Asks before a sync pass deletes more files than the mass-deletion guard
 * allows. Closing the modal without choosing keeps the deletions paused; the
 * "Review paused deletions" command opens it again.
 */
export class HeldDeletionModal extends Modal {
  private chosen: DeletionChoice = null;

  constructor(
    app: App,
    private side: DeletionSide,
    private rels: string[],
    private remoteRoot: string,
    private onChoose: (choice: DeletionChoice) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const n = this.rels.length;
    const { contentEl } = this;
    const local = this.side === "local";

    this.titleEl.setText(
      local ? `Delete ${n} notes from this vault?` : `Delete ${n} files from your Plum Box?`,
    );
    contentEl.createEl("p", {
      text: local
        ? `${n} files are no longer in "${this.remoteRoot}" on your Plum Box. Plum Sync would move them to this vault's .trash.`
        : `${n} files are missing from this vault. Plum Sync would move them to the Plum Box trash.`,
    });
    contentEl.createEl("p", {
      text:
        "That is more than Plum Sync deletes without asking. " +
        (local
          ? "If you didn't delete them on purpose, the folder on the box may have been moved or renamed."
          : "If you didn't delete them on purpose, the vault may not have finished loading, or files were moved out of it."),
    });
    const ul = contentEl.createEl("ul");
    for (const rel of this.rels.slice(0, PREVIEW)) ul.createEl("li", { text: rel });
    if (n > PREVIEW) ul.createEl("li", { text: `… and ${n - PREVIEW} more` });

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText(local ? "Keep files and re-upload" : "Keep files and re-download")
          .setCta()
          .onClick(() => this.choose("keep")),
      )
      .addButton((b) =>
        b
          .setButtonText(`Delete ${n} files`)
          .setWarning()
          .onClick(() => this.choose("delete")),
      );
  }

  private choose(choice: Exclude<DeletionChoice, null>): void {
    this.chosen = choice;
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    this.onChoose(this.chosen);
  }
}
