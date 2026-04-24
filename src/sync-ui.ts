import { App, Modal, Notice, Setting } from "obsidian";
import { GetNoteApiClient, KnowledgeBaseItem, BloggerItem } from "./get-api";

/** 让出主线程一帧，便于刷新进度条与文案 */
function yieldToUI(): Promise<void> {
	return new Promise((resolve) => {
		window.requestAnimationFrame(() => resolve());
	});
}

/** 同步选项 */
export interface SyncOptions {
	afterDate?: number; // 毫秒时间戳，仅同步此之后更新的笔记
	forceUpdate?: boolean; // 是否覆盖本地已有笔记
	mode: "incremental" | "full";
}

/** 知识库同步选项 */
export interface KnowledgeBaseSyncOptions extends SyncOptions {
	topicId: string;
	topicName: string;
}

/** 博主同步选项 */
export interface BloggerSyncOptions extends SyncOptions {
	topicId: string;
	topicName: string;
	followId: number;
	bloggerName: string;
	platform: string;
}

/**
 * 同步前置选择弹窗：选择日期范围与策略
 */
export class SyncStartModal extends Modal {
	private options: SyncOptions;
	private onConfirm: (options: SyncOptions) => void;

	constructor(app: App, defaultMode: "incremental" | "full", onConfirm: (options: SyncOptions) => void) {
		super(app);
		this.onConfirm = onConfirm;
		this.options = {
			mode: defaultMode,
			forceUpdate: false,
			afterDate: undefined,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("getbiji-sync-modal-minwidth");
		contentEl.addClass("getbiji-sync-start-modal");

		// 1. 标题与副标题
		contentEl.createEl("h2", { text: "同步我的笔记" });
		contentEl.createDiv({
			cls: "getbiji-sync-modal-subtitle",
			text: "设置同步的时间范围与覆盖策略，优化笔记处理效率。",
		});

		// 2. 日期选择区域
		const dateContainer = contentEl.createDiv({ cls: "getbiji-date-container" });
		const dateSetting = new Setting(dateContainer)
			.setName("同步起始时间")
			.setDesc("仅处理在此日期之后更新的笔记（留空默认为全部）")
			.addText((text) => {
				text.inputEl.type = "date";
				text.onChange((value) => {
					this.options.afterDate = value ? new Date(value).getTime() : undefined;
					pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				});
			});

		// 3. 快捷胶囊按钮组
		const pillGroup = dateContainer.createDiv({ cls: "getbiji-pill-group" });
		const addPill = (label: string, days: number | null) => {
			const btn = pillGroup.createEl("button", { text: label, cls: "getbiji-pill-btn" });
			if (days === null && !this.options.afterDate) btn.addClass("is-active");

			btn.addEventListener("click", () => {
				pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				btn.addClass("is-active");
				const input = dateSetting.controlEl.querySelector("input[type='date']") as HTMLInputElement;
				if (days === null) {
					this.options.afterDate = undefined;
					if (input) input.value = "";
				} else {
					const date = new Date();
					date.setDate(date.getDate() - days);
					const dateStr = date.toISOString().split("T")[0] || "";
					if (input && dateStr) {
						input.value = dateStr;
						this.options.afterDate = new Date(dateStr).getTime();
					}
				}
			});
		};

		addPill("最近3天", 3);
		addPill("最近1周", 7);
		addPill("最近1月", 30);
		addPill("全部内容", null);

		// 4. 同步方式逻辑
		new Setting(contentEl)
			.setName("同步方式")
			.setDesc("增量同步仅处理新内容，全量同步可处理历史更新")
			.addDropdown((dp) => {
				dp.addOption("incremental", "增量同步")
					.addOption("full", "全量同步")
					.setValue(this.options.mode)
					.onChange((val: "incremental" | "full") => {
						this.options.mode = val;
					});
			});

		// 5. 策略选择
		const strategySetting = new Setting(contentEl)
			.setName("覆盖本地更新")
			.setDesc("开启后将对本地已有的笔记内容进行覆盖，请注意内容安全！")
			.addToggle((toggle) => {
				toggle.setValue(this.options.forceUpdate || false).onChange((value) => {
					this.options.forceUpdate = value;
				});
			});
		strategySetting.descEl.addClass("getbiji-warning-text");

		// 6. 操作按钮
		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		const confirmBtn = footer.createEl("button", {
			text: "开始同步",
			cls: "mod-cta",
		});
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm(this.options);
		});

		const cancelBtn = footer.createEl("button", { text: "取消" });
		cancelBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * 同步进度弹窗：先显示「拉取列表」，再显示「逐条同步」与进度条。
 */
export class SyncProgressModal extends Modal {
	/** 用户点击取消后为 true */
	cancelled = false;
	private statusEl!: HTMLDivElement;
	private detailEl!: HTMLDivElement;
	private progressEl!: HTMLProgressElement;
	private cancelBtn!: HTMLButtonElement;
	private bgBtn!: HTMLButtonElement;
	private statusBarItem: HTMLElement | null = null;
	public isBackground = false;

	constructor(app: App, statusBarItem: HTMLElement | null = null) {
		super(app);
		this.statusBarItem = statusBarItem;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.modalEl.addClass("getbiji-sync-modal-minwidth");
		contentEl.addClass("getbiji-sync-modal");
		contentEl.createEl("h2", { text: "同步 get 笔记" });
		this.statusEl = contentEl.createDiv({ text: "准备中…" });
		this.progressEl = contentEl.createEl("progress", { cls: "getbiji-progress" });
		this.progressEl.max = 1;
		this.progressEl.value = 0;
		this.detailEl = contentEl.createDiv({ cls: "setting-item-description getbiji-detail" });

		const row = contentEl.createDiv({ cls: "modal-button-container getbiji-btn-row" });
		this.cancelBtn = row.createEl("button", { text: "取消同步" });
		this.cancelBtn.addEventListener("click", () => {
			this.cancelled = true;
			this.cancelBtn.disabled = true;
			this.statusEl.setText("正在取消…");
			this.updateStatusBar("正在取消同步…");
		});

		this.bgBtn = row.createEl("button", { text: "后台运行", cls: "mod-cta" });
		this.bgBtn.addEventListener("click", () => {
			this.isBackground = true;
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private updateStatusBar(text: string): void {
		if (this.statusBarItem) {
			this.statusBarItem.setText(text);
		}
	}

	/**
	 * 拉取同步列表阶段：每向服务器请求一次列表计为「一批」（不是笔记正文页码）。
	 */
	setListFetching(batchIndex: number, lastBatch: number, total: number): void {
		const status = "正在获取同步列表…";
		const detail = `列表拉取第 ${batchIndex} 批（本批 ${lastBatch} 条，累计 ${total} 条）`;
		
		if (!this.isBackground) {
			this.statusEl.setText(status);
			this.detailEl.setText(detail);
			this.progressEl.removeAttribute("value");
		}
		this.updateStatusBar(`📥 ${status} (${total}条)`);
	}

	/** 进入逐条同步阶段，设置进度条上限 */
	startItemPhase(total: number): void {
		if (!this.isBackground) {
			this.progressEl.max = Math.max(1, total);
			this.progressEl.value = 0;
			this.statusEl.setText(`准备写入，共 ${total} 条`);
			this.detailEl.setText("");
		}
		this.updateStatusBar(`📥 准备同步 (${total}条)`);
	}

	/** 更新当前同步到哪一条 */
	setItemProgress(done: number, total: number, title: string): void {
		if (!this.isBackground) {
			this.progressEl.max = Math.max(1, total);
			this.progressEl.value = done;
			this.statusEl.setText(`正在同步 ${done} / ${total}`);
			this.detailEl.setText(title ? `当前：${title}` : "");
		}
		this.updateStatusBar(`📥 Getbiji: ${done}/${total}`);
	}

	/** 结束态（关闭前短暂展示） */
	setDone(message: string): void {
		if (!this.isBackground) {
			this.statusEl.setText(message);
			this.detailEl.setText("");
			this.cancelBtn.disabled = true;
			this.bgBtn.disabled = true;
		}
		this.updateStatusBar("");
	}

	flush(): Promise<void> {
		return yieldToUI();
	}
}

/**
 * 知识库选择与同步配置弹窗 (分步)
 */
export class KnowledgeBaseSelectModal extends Modal {
	private client: GetNoteApiClient;
	private onConfirm: (options: KnowledgeBaseSyncOptions) => void;
	private kbList: KnowledgeBaseItem[] = [];
	private selectedKb: KnowledgeBaseItem | null = null;
	private step: "select" | "config" = "select";
	private isLoading = false;

	private syncOptions: SyncOptions = {
		mode: "incremental",
		forceUpdate: false,
		afterDate: undefined,
	};

	constructor(
		app: App,
		client: GetNoteApiClient,
		onConfirm: (options: KnowledgeBaseSyncOptions) => void,
	) {
		super(app);
		this.client = client;
		this.onConfirm = onConfirm;
	}

	async onOpen() {
		this.modalEl.addClass("getbiji-sync-modal-minwidth");
		await this.loadKbList();
		this.render();
	}

	async loadKbList() {
		this.isLoading = true;
		this.render();
		try {
			// 目前拉取第一页即可，通常知识库数量不会太多
			const res = await this.client.listKnowledgeBases(1);
			this.kbList = res.topics;
		} catch (e) {
			new Notice("获取知识库列表失败: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			this.isLoading = false;
			this.render();
		}
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();

		if (this.step === "select") {
			this.renderSelectStep(contentEl);
		} else {
			this.renderConfigStep(contentEl);
		}
	}

	private renderSelectStep(el: HTMLElement) {
		el.createEl("h2", { text: "选择同步的知识库" });
		el.createDiv({
			cls: "getbiji-sync-modal-subtitle",
			text: "请选择一个您想要同步到 Obsidian 的 Getbiji 知识库。",
		});

		if (this.isLoading) {
			const loading = el.createDiv({ cls: "getbiji-loading-container" });
			loading.createDiv({ cls: "getbiji-loading-icon" });
			loading.createSpan({ text: "正在获取知识库列表..." });
			return;
		}

		if (this.kbList.length === 0) {
			el.createEl("p", { text: "未找到任何知识库。", cls: "setting-item-description" });
			return;
		}

		const listContainer = el.createDiv({ cls: "getbiji-kb-list" });
		this.kbList.forEach((kb) => {
			const item = listContainer.createDiv({
				cls: "getbiji-kb-item" + (this.selectedKb?.topic_id === kb.topic_id ? " is-selected" : ""),
			});

			item.createDiv({ cls: "getbiji-kb-name", text: kb.name });
			if (kb.description) {
				item.createDiv({ cls: "getbiji-kb-desc", text: kb.description });
			}

			const stats = item.createDiv({ cls: "getbiji-kb-stats" });
			this.addStat(stats, "📝", `${kb.stats.note_count} 笔记`);
			this.addStat(stats, "📁", `${kb.stats.file_count} 文件`);
			this.addStat(stats, "👤", `${kb.stats.blogger_count} 博主`);
			this.addStat(stats, "📺", `${kb.stats.live_count} 直播`);

			item.addEventListener("click", () => {
				this.selectedKb = kb;
				this.step = "config";
				this.render();
			});
		});
	}

	private addStat(parent: HTMLElement, icon: string, text: string) {
		const span = parent.createSpan({ cls: "getbiji-kb-stat-item" });
		span.createSpan({ text: icon });
		span.createSpan({ text: text });
	}

	private renderConfigStep(el: HTMLElement) {
		if (!this.selectedKb) return;

		el.createEl("h2", { text: `同步配置：${this.selectedKb.name}` });
		
		const backBtn = el.createEl("button", { text: "← 返回选择", cls: "getbiji-back-btn" });
		backBtn.addEventListener("click", () => {
			this.step = "select";
			this.render();
		});

		// 复用类似 SyncStartModal 的配置 UI
		const dateContainer = el.createDiv({ cls: "getbiji-date-container" });
		const dateSetting = new Setting(dateContainer)
			.setName("同步起始时间")
			.setDesc("仅分析在此之后更新的笔记")
			.addText((text) => {
				text.inputEl.type = "date";
				text.onChange((value) => {
					this.syncOptions.afterDate = value ? new Date(value).getTime() : undefined;
					pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				});
			});

		const pillGroup = dateContainer.createDiv({ cls: "getbiji-pill-group" });
		const addPill = (label: string, days: number | null) => {
			const btn = pillGroup.createEl("button", { text: label, cls: "getbiji-pill-btn" });
			if (days === null) btn.addClass("is-active");

			btn.addEventListener("click", () => {
				pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				btn.addClass("is-active");
				const input = dateSetting.controlEl.querySelector("input[type='date']") as HTMLInputElement;
				if (days === null) {
					this.syncOptions.afterDate = undefined;
					if (input) input.value = "";
				} else {
					const date = new Date();
					date.setDate(date.getDate() - days);
					const dateStr = date.toISOString().split("T")[0];
					if (input && dateStr) {
						input.value = dateStr;
						this.syncOptions.afterDate = new Date(dateStr).getTime();
					}
				}
			});
		};
		addPill("最近3天", 3);
		addPill("最近1周", 7);
		addPill("最近1月", 30);
		addPill("全部内容", null);

		new Setting(el)
			.setName("同步方式")
			.setDesc("全量同步将覆盖本地已修改的内容")
			.addDropdown((dp) => {
				dp.addOption("incremental", "增量同步")
					.addOption("full", "全量同步")
					.setValue(this.syncOptions.mode)
					.onChange((val: "incremental" | "full") => {
						this.syncOptions.mode = val;
					});
			});

		new Setting(el)
			.setName("覆盖本地更新")
			.setDesc("开启后将对本地已有笔记进行覆盖")
			.addToggle((tg) => {
				tg.setValue(this.syncOptions.forceUpdate || false).onChange((v) => {
					this.syncOptions.forceUpdate = v;
				});
			});

		const footer = el.createDiv({ cls: "modal-button-container" });
		const confirmBtn = footer.createEl("button", { text: "开始同步", cls: "mod-cta" });
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm({
				...this.syncOptions,
				topicId: this.selectedKb!.topic_id,
				topicName: this.selectedKb!.name,
			});
		});

		footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
	}
}

/**
 * 博主选择与同步配置弹窗子类
 */
export class BloggerSelectModal extends Modal {
	private client: GetNoteApiClient;
	private onConfirm: (options: BloggerSyncOptions) => void;
	private aggregatedBloggers: BloggerItem[] = [];
	private selectedBlogger: BloggerItem | null = null;
	private step: "select" | "config" = "select";
	private isLoading = false;

	private syncOptions: SyncOptions = {
		mode: "incremental",
		forceUpdate: false,
		afterDate: undefined,
	};

	constructor(
		app: App,
		client: GetNoteApiClient,
		onConfirm: (options: BloggerSyncOptions) => void,
	) {
		super(app);
		this.client = client;
		this.onConfirm = onConfirm;
	}

	async onOpen() {
		this.modalEl.addClass("getbiji-sync-modal-minwidth");
		await this.loadAllBloggers();
		this.render();
	}

	async loadAllBloggers() {
		this.isLoading = true;
		this.render();
		try {
			// 1. 获取所有专题
			const kbRes = await this.client.listKnowledgeBases(1);
			const topics = kbRes.topics;
			
			const allBloggers: BloggerItem[] = [];
			
			// 2. 遍历专题获取博主
			for (const topic of topics) {
				let page = 1;
				let hasMore = true;
				while (hasMore) {
					// 增加延迟，避免 429 频率过快
					await new Promise(r => setTimeout(r, 500));
					const bloggerRes = await this.client.listBloggers(topic.topic_id, page);
					const bloggers = bloggerRes.bloggers || [];
					for (const b of bloggers) {
						allBloggers.push({
							...b,
							topic_name: topic.name,
							topic_id: topic.topic_id,
						});
					}
					hasMore = bloggerRes.has_more;
					page++;
					if (page > 10) break; // 安全保护
				}
			}
			
			// 去重 (以 follow_id 为准)
			const seen = new Set<number>();
			this.aggregatedBloggers = allBloggers.filter(b => {
				if (seen.has(b.follow_id)) return false;
				seen.add(b.follow_id);
				return true;
			});

		} catch (e) {
			new Notice("获取博主列表失败: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			this.isLoading = false;
			this.render();
		}
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();

		if (this.step === "select") {
			this.renderSelectStep(contentEl);
		} else {
			this.renderConfigStep(contentEl);
		}
	}

	private renderSelectStep(el: HTMLElement) {
		el.createEl("h2", { text: "选择同步的博主" });
		el.createDiv({
			cls: "getbiji-sync-modal-subtitle",
			text: "请选择一个您关注的博主，将其内容同步到 Obsidian。",
		});

		if (this.isLoading) {
			const loading = el.createDiv({ cls: "getbiji-loading-container" });
			loading.createDiv({ cls: "getbiji-loading-icon" });
			loading.createSpan({ text: "正在获取博主列表..." });
			return;
		}

		if (this.aggregatedBloggers.length === 0) {
			el.createEl("p", { text: "未找到任何关注的博主。", cls: "setting-item-description" });
			return;
		}

		const listContainer = el.createDiv({ cls: "getbiji-kb-list" });
		this.aggregatedBloggers.forEach((blogger) => {
			const item = listContainer.createDiv({
				cls: "getbiji-kb-item" + (this.selectedBlogger?.follow_id === blogger.follow_id ? " is-selected" : ""),
			});

			const header = item.createDiv({ cls: "getbiji-kb-name" });
			header.createSpan({ text: blogger.account_name });
			this.renderPlatformTag(header, blogger.platform);

			item.createDiv({ 
				cls: "getbiji-kb-desc", 
				text: `所属知识库：${blogger.topic_name || "未知"}` 
			});

			item.addEventListener("click", () => {
				this.selectedBlogger = blogger;
				this.step = "config";
				this.render();
			});
		});
	}

	/** 渲染平台标签（含图标/品牌色） */
	private renderPlatformTag(container: HTMLElement, platform: string) {
		const p = platform.toLowerCase();
		const tag = container.createSpan({ 
			cls: `getbiji-platform-tag platform-${p}`,
		});

		const iconSvg = this.getPlatformIcon(p);
		if (iconSvg) {
			const iconEl = tag.createSpan({ cls: "getbiji-platform-icon" });
			const parser = new DOMParser();
			const svgDoc = parser.parseFromString(iconSvg, "image/svg+xml");
			const svgElement = svgDoc.documentElement;
			iconEl.appendChild(svgElement);
			tag.createSpan({ text: this.getPlatformName(p) });
		} else {
			tag.setText(platform);
		}
	}

	private getPlatformName(platform: string): string {
		const names: Record<string, string> = {
			douyin: "抖音",
			wechat: "微信",
			dedao: "得到",
			xhs: "小红书",
			zhihu: "知乎",
			bilibili: "B站",
		};
		return names[platform] || platform;
	}

	private getPlatformIcon(platform: string): string | null {
		// 抖音 Logo SVG (标志性的 'd' 符号)
		if (platform === "douyin") {
			return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64 2.93 2.93 0 0 1 .88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.04-.1z"/></svg>`;
		}
		// 微信图标 (气泡)
		if (platform === "wechat") {
			return `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.35 11.23a1.14 1.14 0 1 1-1.14-1.14 1.14 1.14 0 0 1 1.14 1.14zm4.56-1.14a1.14 1.14 0 1 0 1.14 1.14 1.14 1.14 0 0 0-1.14-1.14zm6.09 3.42c0-2.84-2.88-5.14-6.42-5.14s-6.43 2.3-6.43 5.14 2.88 5.14 6.43 5.14a7.1 7.1 0 0 0 1.93-.27l1.83 1c.07.03.11 0 .11-.08v-1.92a4.4 4.4 0 0 0 2.55-3.87zm-1.87-8.11c0-2.37-2.4-4.29-5.36-4.29-2.07 0-3.89.94-4.8 2.38a7.14 7.14 0 0 1 5.8 4.74 7.66 7.66 0 0 1 1.07-.07c4.04 0 7.29 2.58 7.29 5.76a5 5 0 0 1-1.19 3.23l1.51.81c.06.03.09 0 .09-.07v-1.59a3.71 3.71 0 0 0 2-3.32c-.01-4-3.51-7.58-6.41-7.78z"/></svg>`;
		}
		return null;
	}

	private renderConfigStep(el: HTMLElement) {
		if (!this.selectedBlogger) return;

		el.createEl("h2", { text: `同步配置：${this.selectedBlogger.account_name}` });
		
		const backBtn = el.createEl("button", { text: "← 返回选择", cls: "getbiji-back-btn" });
		backBtn.addEventListener("click", () => {
			this.step = "select";
			this.render();
		});

		const dateContainer = el.createDiv({ cls: "getbiji-date-container" });
		const dateSetting = new Setting(dateContainer)
			.setName("同步起始时间")
			.setDesc("仅分析在此发布日期之后的内容")
			.addText((text) => {
				text.inputEl.type = "date";
				text.onChange((value) => {
					this.syncOptions.afterDate = value ? new Date(value).getTime() : undefined;
					pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				});
			});

		const pillGroup = dateContainer.createDiv({ cls: "getbiji-pill-group" });
		const addPill = (label: string, days: number | null) => {
			const btn = pillGroup.createEl("button", { text: label, cls: "getbiji-pill-btn" });
			if (days === null) btn.addClass("is-active");

			btn.addEventListener("click", () => {
				pillGroup.querySelectorAll(".getbiji-pill-btn").forEach((b) => b.removeClass("is-active"));
				btn.addClass("is-active");
				const input = dateSetting.controlEl.querySelector("input[type='date']") as HTMLInputElement;
				if (days === null) {
					this.syncOptions.afterDate = undefined;
					if (input) input.value = "";
				} else {
					const date = new Date();
					date.setDate(date.getDate() - days);
					const dateStr = date.toISOString().split("T")[0];
					if (input && dateStr) {
						input.value = dateStr;
						this.syncOptions.afterDate = new Date(dateStr).getTime();
					}
				}
			});
		};
		addPill("最近3天", 3);
		addPill("最近1周", 7);
		addPill("最近1月", 30);
		addPill("全部内容", null);

		new Setting(el)
			.setName("同步方式")
			.setDesc("建议默认增量同步")
			.addDropdown((dp) => {
				dp.addOption("incremental", "增量同步")
					.addOption("full", "全量同步")
					.setValue(this.syncOptions.mode)
					.onChange((val: "incremental" | "full") => {
						this.syncOptions.mode = val;
					});
			});

		new Setting(el)
			.setName("覆盖本地更新")
			.setDesc("开启后将对本地已有内容进行覆盖")
			.addToggle((tg) => {
				tg.setValue(this.syncOptions.forceUpdate || false).onChange((v) => {
					this.syncOptions.forceUpdate = v;
				});
			});

		const footer = el.createDiv({ cls: "modal-button-container" });
		const confirmBtn = footer.createEl("button", { text: "开始同步", cls: "mod-cta" });
		confirmBtn.addEventListener("click", () => {
			this.close();
			this.onConfirm({
				...this.syncOptions,
				topicId: this.selectedBlogger!.topic_id!,
				topicName: this.selectedBlogger!.topic_name!,
				followId: this.selectedBlogger!.follow_id,
				bloggerName: this.selectedBlogger!.account_name,
				platform: this.selectedBlogger!.platform,
			});
		});

		footer.createEl("button", { text: "取消" }).addEventListener("click", () => this.close());
	}
}
