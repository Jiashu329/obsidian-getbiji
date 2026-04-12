import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, GetNotesSettingTab, type GetNotesSettings } from "./settings";
import { runSync } from "./sync";

/**
 * Get 笔记 → Obsidian 同步插件入口类。
 * 负责生命周期、命令注册与设置加载。
 */
export default class GetNotesPlugin extends Plugin {
	settings!: GetNotesSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		// 左侧功能区：默认增量更新
		this.addRibbonIcon("download-cloud", "同步 get 笔记 (增量更新)", () => {
			void this.syncFromRibbon("incremental");
		});

		this.addCommand({
			id: "pull-notes-incremental",
			name: "同步 get 笔记 (增量更新)",
			callback: () => {
				void this.syncFromRibbon("incremental");
			},
		});

		this.addCommand({
			id: "pull-notes-full",
			name: "同步 get 笔记 (全量更新)",
			callback: () => {
				void this.syncFromRibbon("full");
			},
		});

		this.addSettingTab(new GetNotesSettingTab(this.app, this));
	}

	/** 从侧边栏按钮或命令触发同步，并捕获未处理异常 */
	private async syncFromRibbon(mode: "incremental" | "full"): Promise<void> {
		try {
			await runSync(this, mode);
		} catch {
			// runSync 内已 Notice；此处避免未捕获 Promise
		}
	}

	async loadSettings(): Promise<void> {
		const merged = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<GetNotesSettings>);
		// 兼容旧版 data：无 syncMode 时用默认全量
		if (merged.syncMode !== "full" && merged.syncMode !== "incremental") {
			merged.syncMode = DEFAULT_SETTINGS.syncMode;
		}
		this.settings = merged;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
