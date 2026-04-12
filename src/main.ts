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

		// 左侧功能区：一键触发同步（与命令面板行为一致）
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon("download-cloud", "同步 Get 笔记", () => {
			void this.syncFromRibbon();
		});

		this.addCommand({
			id: "pull-notes-from-api",
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			name: "同步 Get 笔记",
			callback: () => {
				void this.syncFromRibbon();
			},
		});

		this.addSettingTab(new GetNotesSettingTab(this.app, this));
	}

	/** 从侧边栏按钮或命令触发同步，并捕获未处理异常 */
	private async syncFromRibbon(): Promise<void> {
		try {
			await runSync(this);
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
