import { relaunch } from "@tauri-apps/plugin-process";
import type { Update } from "@tauri-apps/plugin-updater";
import { check } from "@tauri-apps/plugin-updater";
import { isNewer, type UpdateState } from "./updatestate";

export class UpdateController {
  private update: Update | null = null;

  constructor(
    private readonly onState: (s: UpdateState, manual?: boolean) => void,
  ) {}

  pending(): { version: string; notes: string } | null {
    return this.update
      ? { version: this.update.version, notes: this.update.body ?? "" }
      : null;
  }

  async checkAuto(): Promise<void> {
    try {
      await this.doCheck(false);
    } catch (e) {
      // Auto mode never interrupts the boot; failures are swallowed on
      // purpose, with no modal or toast surfaced for a quiet background check.
      console.warn("update check (auto) failed:", e);
    }
  }

  async checkManual(): Promise<void> {
    this.onState({ kind: "checking" });
    try {
      const found = await this.doCheck(true);
      if (!found) this.onState({ kind: "uptodate" });
    } catch (e) {
      this.onState({ kind: "error", message: String(e) });
    }
  }

  private async doCheck(manual: boolean): Promise<boolean> {
    const update = await check();
    // The plugin only returns newer updates, but guard the endpoint against
    // ever serving an equal/older version to us.
    if (!update || !isNewer(update.currentVersion, update.version)) {
      this.update = null;
      return false;
    }
    this.update = update;
    this.onState(
      {
        kind: "available",
        version: update.version,
        notes: update.body ?? "",
      },
      manual,
    );
    return true;
  }

  async install(): Promise<void> {
    const update = this.update;
    if (!update) return;
    let total = 0;
    let done = 0;
    this.onState({ kind: "downloading", version: update.version, progress: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        else if (event.event === "Progress") {
          done += event.data.chunkLength;
          const progress = total > 0 ? done / total : 0;
          this.onState({
            kind: "downloading",
            version: update.version,
            progress,
          });
        } else if (event.event === "Finished") {
          this.onState({ kind: "ready", version: update.version });
        }
      });
    } catch (e) {
      // A bad signature or interrupted download lands here; never relaunch.
      this.onState({ kind: "error", message: String(e) });
      return;
    }
    await relaunch();
  }
}
