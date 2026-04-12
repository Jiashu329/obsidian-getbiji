import {
	AbstractInputSuggest,
	App,
	prepareSimpleSearch,
	sortSearchResults,
	TFolder,
	type SearchResult,
} from "obsidian";

/**
 * 挂在「同步目录」输入框上：根据当前输入，在下方弹出仓库内已有文件夹路径供点选。
 * 依赖 Obsidian 1.4.10+ 的 AbstractInputSuggest。
 */
export class VaultFolderPathSuggest extends AbstractInputSuggest<string> {
	/** 打开设置页时快照的文件夹路径列表（避免每次按键全量遍历 vault） */
	private readonly folderPaths: string[];

	/**
	 * @param app Obsidian 应用实例
	 * @param inputEl 设置里的文本框 DOM
	 * @param onChoose 用户从列表选中某条路径后的回调（用于写入配置）
	 */
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly onChoose: (path: string) => void,
	) {
		super(app, inputEl);
		this.folderPaths = VaultFolderPathSuggest.collectFolderPaths(app);
	}

	/** 递归收集 vault 内所有文件夹的相对路径（不含根目录空名） */
	private static collectFolderPaths(app: App): string[] {
		const out: string[] = [];
		const walk = (folder: TFolder, prefix: string) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					const path = prefix ? `${prefix}/${child.name}` : child.name;
					out.push(path);
					walk(child, path);
				}
			}
		};
		walk(app.vault.getRoot(), "");
		return out;
	}

	/** 根据输入字符串返回候选路径（空输入时给出一批按字母排序的浅表路径） */
	protected getSuggestions(query: string): string[] {
		const q = query.trim();
		if (!q) {
			return [...this.folderPaths].sort((a, b) => a.localeCompare(b)).slice(0, 30);
		}
		const matcher = prepareSimpleSearch(q);
		const matches: { text: string; match: SearchResult }[] = [];
		for (const text of this.folderPaths) {
			const match = matcher(text);
			if (match) {
				matches.push({ text, match });
			}
		}
		sortSearchResults(matches);
		return matches.map((m) => m.text).slice(0, 50);
	}

	/** 渲染下拉列表中的每一项 */
	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	/**
	 * 用户点选某条路径。
	 * 必须先 close 再改输入框：若在浮层未卸载时 setValue，会触发 input 事件，
	 * Obsidian 的建议组件可能重入或卡住快捷键作用域，表现为整窗假死。
	 */
	selectSuggestion(path: string, evt: MouseEvent | KeyboardEvent): void {
		this.close();
		// 使用 globalThis 避免 activeWindow 在类型检查/ESLint 上与 Window 不一致
		globalThis.setTimeout(() => {
			this.setValue(path);
			this.onChoose(path);
		}, 0);
	}
}
