import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, GetNotesSettingTab, type GetNotesSettings } from "./settings";
import { runSync, runKnowledgeBaseSync } from "./sync";
import { SyncStartModal, KnowledgeBaseSelectModal } from "./sync-ui";
import { GetNoteApiClient } from "./get-api";
import type { SyncModalLike } from "./context";

/**
 * Get 笔记 → Obsidian 同步插件入口类。
 * 负责生命周期、命令注册与设置加载。
 */
export default class GetNotesPlugin extends Plugin {
	settings!: GetNotesSettings;
	statusBarItem!: HTMLElement;
	activeSync: { modal: SyncModalLike; promise: Promise<void> } | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusBarItem = this.addStatusBarItem();

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

		this.addCommand({
			id: "pull-knowledge-base",
			name: "同步指定知识库",
			callback: () => {
				void this.syncKnowledgeBase();
			},
		});

		this.addSettingTab(new GetNotesSettingTab(this.app, this));
	}

	private syncKnowledgeBase(): void {
		if (this.activeSync) {
			this.activeSync.modal.isBackground = false;
			this.activeSync.modal.open();
			return;
		}

		const { clientId, apiKey, authUseRawKey } = this.settings;
		const client = new GetNoteApiClient(apiKey, clientId, authUseRawKey);

		new KnowledgeBaseSelectModal(this.app, client, (options) => {
			void (async () => {
				try {
					await runKnowledgeBaseSync(this, options);
				} catch {
					// 内部已 Notice
				}
			})();
		}).open();
	}

	/** 从侧边栏按钮或命令触发同步 */
	private syncFromRibbon(mode: "incremental" | "full"): void {
		if (this.activeSync) {
			this.activeSync.modal.isBackground = false;
			this.activeSync.modal.open();
			return;
		}

		// 弹出前置选择框
		new SyncStartModal(this.app, mode, (options) => {
			void (async () => {
				try {
					await runSync(this, options);
				} catch {
					// runSync 内已 Notice；此处避免未捕获 Promise
				}
			})();
		}).open();
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
