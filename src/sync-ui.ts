import { App, Modal, Setting } from "obsidian";

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

/**
 * 同步前置选择弹窗：选择日期范围与策略
 */
export class SyncStartModal extends Modal {
	private options: SyncOptions;
	private onConfirm: (options: SyncOptions) => void;

	constructor(app: App, mode: "incremental" | "full", onConfirm: (options: SyncOptions) => void) {
		super(app);
		this.onConfirm = onConfirm;
		this.options = {
			mode,
			forceUpdate: false,
			afterDate: undefined,
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("getbiji-sync-start-modal");

		contentEl.createEl("h2", { text: (this.options.mode === "full" ? "全量" : "增量") + "同步配置" });

		// 1. 日期选择
		const dateContainer = contentEl.createDiv({ cls: "getbiji-date-container" });
		new Setting(dateContainer)
			.setName("同步起始时间")
			.setDesc("仅同步在此时间之后有更新的笔记（留空表示同步全部）")
			.addText((text) => {
				text.inputEl.type = "date";
				text.onChange((value) => {
					this.options.afterDate = value ? new Date(value).getTime() : undefined;
				});
			});

		// 2. 快捷按钮
		const quickButtons = contentEl.createDiv({ cls: "getbiji-quick-buttons" });
		const addQuickBtn = (label: string, days: number | null) => {
			const btn = quickButtons.createEl("button", { text: label, cls: "mod-subtle" });
			btn.style.marginRight = "8px";
			btn.style.marginBottom = "8px";
			btn.addEventListener("click", () => {
				if (days === null) {
					// 这里的逻辑：如果是 null，我们就清空日期选择器及 options
					this.options.afterDate = undefined;
					const input = dateContainer.querySelector("input[type='date']") as HTMLInputElement;
					if (input) input.value = "";
				} else {
					const date = new Date();
					date.setDate(date.getDate() - days);
					// 格式化为 YYYY-MM-DD 以同步到 input 框
					const dateStr = date.toISOString().split("T")[0] || "";
					const input = dateContainer.querySelector("input[type='date']") as HTMLInputElement;
					if (input && dateStr) {
						input.value = dateStr;
						this.options.afterDate = new Date(dateStr).getTime();
					}
				}
			});
		};

		addQuickBtn("最近3天", 3);
		addQuickBtn("最近1周", 7);
		addQuickBtn("最近1月", 30);
		addQuickBtn("全部", null);

		// 3. 策略选择
		new Setting(contentEl)
			.setName("覆盖更新")
			.setDesc("开启后，即使本地已存在该笔记，若满足时间筛选也会重新拉取并覆盖")
			.addToggle((toggle) => {
				toggle.setValue(this.options.forceUpdate || false).onChange((value) => {
					this.options.forceUpdate = value;
				});
			});

		// 4. 操作按钮
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
		this.modalEl.style.minWidth = "400px";
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
		this.updateStatusBar(`📥 GetBiji: ${done}/${total}`);
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
