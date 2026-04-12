import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { VaultFolderPathSuggest } from "./vault-folder-suggest";

/** 同步策略：全量始终覆盖；增量在本地已有同 get_note_id 时跳过该条 */
export type SyncMode = "full" | "incremental";

/** 插件持久化配置（会写入 Obsidian 插件数据目录） */
export interface GetNotesSettings {
	/** 开放平台应用 Client ID */
	clientId: string;
	/** 开放平台 API Key（Bearer） */
	apiKey: string;
	/** 笔记写入的 Vault 相对目录 */
	folderPath: string;
	/**
	 * 全量：逐项拉详情并覆盖写入。
	 * 增量：同步目录下 frontmatter 中已有相同 get_note_id 的笔记则跳过（不拉详情、不改文件）。
	 */
	syncMode: SyncMode;
	/**
	 * 为 true 时 Authorization 直接传 API Key（无 Bearer 前缀）。
	 * 不在设置页展示，仍持久化。
	 */
	authUseRawKey: boolean;
	/**
	 * 每条笔记处理完后暂停的毫秒数（0～5000）。
	 * 不在设置页展示，仍持久化。
	 */
	requestGapMs: number;
}

export const DEFAULT_SETTINGS: GetNotesSettings = {
	clientId: "",
	apiKey: "",
	folderPath: "GetBiji",
	syncMode: "full",
	authUseRawKey: false,
	requestGapMs: 600,
};

/** 设置页所需插件类型（避免 settings ↔ main 循环引用） */
export type GetNotesPluginBridge = Plugin & {
	settings: GetNotesSettings;
	saveSettings(): Promise<void>;
};

/** 设置页当前选中的页签（仅 UI，不写进 data.json） */
type SettingsTabId = "sync" | "about";

export class GetNotesSettingTab extends PluginSettingTab {
	plugin: GetNotesPluginBridge;
	private activeTab: SettingsTabId = "sync";

	constructor(app: App, plugin: GetNotesPluginBridge) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("getbiji-settings-root");


		// 页签栏：同步信息 | 关于（其余参数不在界面展示，仍保留默认值或历史 data）
		const tabBar = containerEl.createDiv({ cls: "getbiji-tab-bar" });
		this.renderTabButton(tabBar, "sync", "同步信息");
		this.renderTabButton(tabBar, "about", "关于");

		const panelHost = containerEl.createDiv({ cls: "getbiji-tab-panel-host" });
		if (this.activeTab === "sync") {
			this.renderSyncInfoTab(panelHost);
		} else {
			this.renderAboutTab(panelHost);
		}
	}

	/** 渲染单个页签按钮 */
	private renderTabButton(parent: HTMLElement, id: SettingsTabId, label: string): void {
		const btn = parent.createEl("button", {
			type: "button",
			text: label,
			cls: "getbiji-tab-btn",
		});
		if (this.activeTab === id) {
			btn.addClass("getbiji-tab-btn-active");
		}
		btn.addEventListener("click", () => {
			this.activeTab = id;
			this.display();
		});
	}

	/** 页签「同步信息」：顶部说明 + Client ID、API Key、同步目录 */
	private renderSyncInfoTab(container: HTMLElement): void {
		// 开放平台说明（原「关于」中的同步说明，现置于本页签表单上方）
		const intro = container.createEl("p", {
			cls: "getbiji-sync-intro setting-item-description",
		});
		intro.createSpan({
			text: "Getbiji通过Get笔记官方开放平台API同步到Obsidian中，您可以在",
		});
		const openApiLink = intro.createEl("a", {
			href: "https://www.biji.com/openapi",
			text: "Get笔记开放平台",
		});
		openApiLink.setAttr("target", "_blank");
		openApiLink.setAttr("rel", "noopener");
		intro.createSpan({
			text: "中获取Client ID和API Key。所有密钥均存本地。",
		});

		new Setting(container)
			.setName("Client id")
			 
			.setDesc(
				"可以在 get 笔记开放平台-应用管理，新建应用（权限请给：读取笔记权限）后得到，应为：cli_XXX格式的 id 串。",
			)
			.addText((text) =>
				text
					 
					.setPlaceholder("cli_xxx")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(container)
			 
			.setName("API key")
			 
			.setDesc(
				"可以在 get 笔记开放平台-API key，创建 API key 后得到，应为：gk_XXX格式的 id 串。",
			)
			.addText((text) => {
				 
				text.setPlaceholder("gk_live_xxx");
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.apiKey);
				text.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(container)
			.setName("同步目录")
			.setDesc("请选择同步后的笔记存放地址，如地址不存在，将会自动创建。")
			.addText((text) => {
				text
					 
					.setPlaceholder("GetBiji")
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.folderPath = value.trim() || "GetBiji";
						await this.plugin.saveSettings();
					});
				// 路径自动补全：点选后由 suggest 延迟 setValue，此处只写配置，勿再 text.setValue（避免重复触发 input）
				new VaultFolderPathSuggest(this.app, text.inputEl, (picked) => {
					void (async () => {
						this.plugin.settings.folderPath = picked.trim() || "GetBiji";
						await this.plugin.saveSettings();
					})();
				});
			});

	}

	/** 页签「关于」：仅作者信息 */
	private renderAboutTab(container: HTMLElement): void {
		container.createEl("p", {
			text: "Author: Jiashu",
			cls: "setting-item-description",
		});
	}
}
