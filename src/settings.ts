import { App, Plugin, PluginSettingTab, Setting } from "obsidian";

/** 插件持久化配置（会写入 Obsidian 插件数据目录） */
export interface GetNotesSettings {
	/** 开放平台应用 Client ID */
	clientId: string;
	/** 开放平台 API Key（Bearer） */
	apiKey: string;
	/** 笔记写入的 Vault 相对目录 */
	folderPath: string;
	/**
	 * 列表接口游标：下次同步从该 since_id 继续（增量）。
	 * 设为 0 表示从头拉取。
	 */
	sinceId: number;
}

export const DEFAULT_SETTINGS: GetNotesSettings = {
	clientId: "",
	apiKey: "",
	folderPath: "Get-notes",
	sinceId: 0,
};

/** 设置页所需插件类型（避免 settings ↔ main 循环引用） */
export type GetNotesPluginBridge = Plugin & {
	settings: GetNotesSettings;
	saveSettings(): Promise<void>;
};

export class GetNotesSettingTab extends PluginSettingTab {
	plugin: GetNotesPluginBridge;

	constructor(app: App, plugin: GetNotesPluginBridge) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Connection").setHeading();

		containerEl.createEl("p", {
			text: "Create an app at https://www.biji.com/openapi to get a Client ID and API key. Credentials stay on this device only.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Open platform client ID (X-Client-ID header).")
			.addText((text) =>
				text
					.setPlaceholder("cli_xxx")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API key")
			.setDesc("Open platform API key (Authorization: Bearer …).")
			.addText((text) => {
				text.setPlaceholder("gk_live_xxx");
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.apiKey);
				text.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Sync folder")
			.setDesc("Path inside the vault; folders are created if missing.")
			.addText((text) =>
				text
					.setPlaceholder("Get-notes")
					.setValue(this.plugin.settings.folderPath)
					.onChange(async (value) => {
						this.plugin.settings.folderPath = value.trim() || "Get-notes";
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("List cursor (since_id)")
			.setDesc(
				"Used for incremental sync; you rarely need to edit this. Use “reset cursor” below to run a full sync from the beginning.",
			)
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.sinceId))
					.onChange(async (value) => {
						const n = Number.parseInt(value.trim(), 10);
						this.plugin.settings.sinceId = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Reset cursor (full sync next)")
			.setDesc("Sets since_id to 0. The next sync starts from the beginning (slower; may overwrite files).")
			.addButton((btn) =>
				btn.setButtonText("Reset to 0").onClick(async () => {
					this.plugin.settings.sinceId = 0;
					await this.plugin.saveSettings();
					this.display();
				}),
			);
	}
}
