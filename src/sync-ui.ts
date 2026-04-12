import { App, Modal } from "obsidian";

/** 让出主线程一帧，便于刷新进度条与文案 */
function yieldToUI(): Promise<void> {
	return new Promise((resolve) => {
		window.requestAnimationFrame(() => resolve());
	});
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

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("getbiji-sync-modal");
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		contentEl.createEl("h2", { text: "同步 Get 笔记" });
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
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/**
	 * 拉取同步列表阶段：每向服务器请求一次列表计为「一批」（不是笔记正文页码）。
	 */
	setListFetching(batchIndex: number, lastBatch: number, total: number): void {
		this.statusEl.setText("正在获取同步列表…");
		this.detailEl.setText(`列表拉取第 ${batchIndex} 批（本批 ${lastBatch} 条，累计 ${total} 条）`);
		this.progressEl.removeAttribute("value");
	}

	/** 进入逐条同步阶段，设置进度条上限 */
	startItemPhase(total: number): void {
		this.progressEl.max = Math.max(1, total);
		this.progressEl.value = 0;
		this.statusEl.setText(`准备写入，共 ${total} 条`);
		this.detailEl.setText("");
	}

	/** 更新当前同步到哪一条 */
	setItemProgress(done: number, total: number, title: string): void {
		this.progressEl.max = Math.max(1, total);
		this.progressEl.value = done;
		this.statusEl.setText(`正在同步 ${done} / ${total}`);
		this.detailEl.setText(title ? `当前：${title}` : "");
	}

	/** 结束态（关闭前短暂展示） */
	setDone(message: string): void {
		this.statusEl.setText(message);
		this.detailEl.setText("");
		this.cancelBtn.disabled = true;
	}

	flush(): Promise<void> {
		return yieldToUI();
	}
}
