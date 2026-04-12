import type { App } from "obsidian";
import type { GetNotesSettings } from "./settings";

/**
 * 同步逻辑所需的最小插件形状（避免 sync 与 main 循环引用）。
 */
export interface GetNotesPluginLike {
	app: App;
	settings: GetNotesSettings;
	saveSettings(): Promise<void>;
}
