import { normalizePath, Notice, TFile } from "obsidian";
import { GetNoteApiClient, resolveListNoteId, type NoteDetail, type NoteListItem } from "./get-api";
import type { GetNotesPluginLike } from "./context";
import { SyncProgressModal } from "./sync-ui";

/** 同步过程中在两次网络请求之间暂停，减轻 429 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 将标题等转为可用于文件名的安全字符串（去掉 Windows/Unix 非法字符）。
 */
function sanitizeFileName(name: string): string {
	const s = name.replace(/[\\/:*?"<>|]/g, "_").trim();
	return s.length > 0 ? s.slice(0, 120) : "未命名";
}

/** YAML 列表项：必要时加引号，避免特殊字符破坏 frontmatter */
function yamlListItem(s: string): string {
	const safe = s.replace(/"/g, '\\"');
	return `  - "${safe}"`;
}

/** YAML 双引号标量（frontmatter 内一行值） */
function yamlQuotedScalar(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 附件里 type=link 时，用 API 的 title + url 拼成 Markdown 链接文案 `[title](url)` */
function attachmentToMarkdownLink(a: { title?: string; url: string }): string {
	const t = a.title ?? "";
	return t.length > 0 ? `[${t}](${a.url})` : `[](${a.url})`;
}

/**
 * 将**第一条** `type` 为 link 的附件写到 frontmatter 顶层 `Link: "[title](url)"`（选项 C）。
 * 同一条不再写入 `get_note_attachments`，避免与顶层重复。
 */
function linkAttachmentsToRootYaml(attachments: NonNullable<NoteDetail["attachments"]>): string[] {
	const first = attachments.find((a) => a.type?.toLowerCase() === "link");
	if (!first) {
		return [];
	}
	return [`Link: ${yamlQuotedScalar(attachmentToMarkdownLink(first))}`];
}

/**
 * 将附件写入 `get_note_attachments`：仅包含**非 link** 类型。
 * 第一条 link 只写在顶层 `Link`；第 2 条及以后的 link 不写进文档属性，只在正文「关联链接」中展示。
 */
function attachmentsToYamlBlock(attachments: NonNullable<NoteDetail["attachments"]>): string[] {
	const firstLinkIdx = attachments.findIndex((a) => a.type?.toLowerCase() === "link");
	const rest =
		firstLinkIdx >= 0 ? attachments.filter((_, i) => i !== firstLinkIdx) : [...attachments];
	const nonLinkOnly = rest.filter((a) => a.type?.toLowerCase() !== "link");
	if (nonLinkOnly.length === 0) {
		return [];
	}
	const lines: string[] = ["get_note_attachments:"];
	for (const a of nonLinkOnly) {
		const mdLink = attachmentToMarkdownLink(a);
		lines.push("  -");
		// type 多为 link / image 等简单词，无引号更易读；否则用引号包起来
		const typeScalar = /^[\w-]+$/.test(a.type) ? a.type : yamlQuotedScalar(a.type);
		lines.push(`    type: ${typeScalar}`);
		lines.push(`    url: ${yamlQuotedScalar(a.url)}`);
		if (a.title !== undefined && a.title.length > 0) {
			lines.push(`    title: ${yamlQuotedScalar(a.title)}`);
		}
		if (typeof a.size === "number" && Number.isFinite(a.size)) {
			lines.push(`    size: ${a.size}`);
		}
		if (typeof a.duration === "number" && Number.isFinite(a.duration)) {
			lines.push(`    duration: ${a.duration}`);
		}
		lines.push(`    link: ${yamlQuotedScalar(mdLink)}`);
	}
	return lines;
}

/** 同步为 Markdown 时的可选参数：用于把 Get 内链转成 Obsidian 双链 */
export interface NoteMarkdownOptions {
	idToBasename?: Map<number, string>;
	folder?: string;
}

/**
 * 将一条 Get 笔记详情转为 Markdown 文本（含 YAML frontmatter）。
 * 若传入 idToBasename + folder，会把正文 / 引用里指向 biji 的笔记 URL 转为 `[[同步目录/标题]]`。
 */
export function noteDetailToMarkdown(note: NoteDetail, opt?: NoteMarkdownOptions): string {
	const tagNames = (note.tags ?? []).map((t) => t.name).filter(Boolean);
	const tagsBlock =
		tagNames.length > 0 ? ["tags:", ...tagNames.map(yamlListItem)] : ["tags: []"];
	const linkRoot =
		note.attachments && note.attachments.length > 0 ? linkAttachmentsToRootYaml(note.attachments) : [];
	const attBlock =
		note.attachments && note.attachments.length > 0 ? attachmentsToYamlBlock(note.attachments) : [];
	const fm = [
		"---",
		`get_note_id: ${note.id}`,
		`title: "${(note.title ?? "").replace(/"/g, '\\"')}"`,
		`note_type: ${note.note_type ?? ""}`,
		`source: ${note.source ?? ""}`,
		`updated_at: ${note.updated_at ?? ""}`,
		`created_at: ${note.created_at ?? ""}`,
		...linkRoot,
		...tagsBlock,
		...attBlock,
		"---",
		"",
	];
	const parts: string[] = [...fm, `# ${note.title || "(无标题)"}`, ""];
	const c = note.content?.trim();
	const r = note.ref_content?.trim();
	const blocks: string[] = [];
	if (c) blocks.push(c);
	if (r && r !== c) blocks.push(r);
	let body = blocks.join("\n\n");
	if (body.length > 0 && opt?.idToBasename && opt.folder) {
		body = rewriteBijiNoteLinksToWiki(body, opt.idToBasename, opt.folder);
	}
	if (body.length > 0) {
		parts.push(body);
		parts.push("");
	}
	// 正文可见的链接列表（属性里的 Link / get_note_attachments 在阅读视图不显眼；详情失败时列表也可能无附件）
	const associated = collectAssociatedLinkRows(note);
	if (associated.length > 0) {
		parts.push("## 关联链接", "");
		for (const { url, title } of associated) {
			parts.push(`- [${escapeMdLinkLabel(title)}](${url})`);
		}
		parts.push("");
	}
	if (note.web_page?.url) {
		parts.push("## 链接", "");
		parts.push(`- 地址：${note.web_page.url}`);
		if (note.web_page.excerpt) parts.push(`- 摘要：${note.web_page.excerpt}`);
		if (note.web_page.content) {
			parts.push("", "### 网页正文摘录", "", note.web_page.content);
		}
		parts.push("");
	}
	if (note.audio?.play_url) {
		parts.push("## 音频", "", `- [播放](${note.audio.play_url})`, "");
	}
	return parts.join("\n");
}

/** Markdown 链接文字里需要转义的字符，避免标题含 [] 弄坏链接 */
function escapeMdLinkLabel(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** 去掉简单 HTML 标签，用于 <a> 内联文案 */
function stripHtmlTags(s: string): string {
	return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

/** 从 HTML 正文里抽出 <a href="http..."> 外链 */
function extractHrefLinksFromHtml(html: string): { url: string; title: string }[] {
	if (!html) return [];
	const out: { url: string; title: string }[] = [];
	const re = /<a\s+[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const href = m[1];
		const inner = m[2];
		if (href === undefined || inner === undefined) continue;
		const url = href.replace(/&amp;/g, "&").trim();
		const title = stripHtmlTags(inner) || url;
		if (!/^https?:\/\//i.test(url)) continue;
		if (/^javascript:/i.test(url)) continue;
		out.push({ url, title });
	}
	return out;
}

/** 从正文里抽出 Markdown 形式 [文字](http...) 外链 */
function extractMarkdownLinksFromText(text: string): { url: string; title: string }[] {
	if (!text) return [];
	const out: { url: string; title: string }[] = [];
	const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const label = m[1] ?? "";
		const href = m[2];
		if (href === undefined) continue;
		const url = href.replace(/&amp;/g, "&").trim();
		out.push({ title: label.trim() || url, url });
	}
	return out;
}

function canonicalUrlKey(url: string): string {
	return url.replace(/&amp;/g, "&").trim().split("#")[0] ?? url;
}

/** 判断是否为「Get 站内笔记 URL」（正文里会改成双链，不在「关联链接」重复列） */
function isBijiNoteUrlForWiki(url: string): boolean {
	const u = url.replace(/&amp;/g, "&");
	return /biji\.com/i.test(u) && extractNoteIdFromBijiUrl(u) !== undefined;
}

/**
 * 汇总要在正文里展示的链接：附件 type=link + 正文 HTML/Markdown 里的外链。
 * 与 web_page 主 URL 去重，避免和下方「## 链接」块重复。
 */
function collectAssociatedLinkRows(note: NoteDetail): { url: string; title: string }[] {
	const seen = new Set<string>();
	const rows: { url: string; title: string }[] = [];

	const add = (url: string, title: string) => {
		const u = url.replace(/&amp;/g, "&").trim();
		if (!/^https?:\/\//i.test(u)) return;
		const key = canonicalUrlKey(u);
		if (seen.has(key)) return;
		seen.add(key);
		const t = (title || u).trim() || u;
		rows.push({ url: u, title: t });
	};

	for (const a of note.attachments ?? []) {
		if (a.type?.toLowerCase() !== "link") continue;
		add(a.url, a.title ?? "");
	}

	const webUrl = note.web_page?.url?.replace(/&amp;/g, "&").trim();
	if (webUrl) {
		seen.add(canonicalUrlKey(webUrl));
	}

	const blob = [note.content, note.ref_content].filter(Boolean).join("\n");
	for (const { url, title } of extractHrefLinksFromHtml(blob)) {
		if (isBijiNoteUrlForWiki(url)) continue;
		add(url, title);
	}
	for (const { url, title } of extractMarkdownLinksFromText(blob)) {
		if (isBijiNoteUrlForWiki(url)) continue;
		add(url, title);
	}

	return rows;
}

/**
 * 确保 Vault 中存在相对路径文件夹（逐级创建）。
 */
async function ensureFolder(vault: GetNotesPluginLike["app"]["vault"], folderPath: string): Promise<void> {
	const normalized = normalizePath(folderPath.trim());
	if (!normalized || normalized === ".") return;
	const parts = normalized.split("/");
	let acc = "";
	for (const p of parts) {
		acc = acc ? `${acc}/${p}` : p;
		const existing = vault.getAbstractFileByPath(acc);
		if (!existing) {
			await vault.createFolder(acc);
		}
	}
}

/**
 * 为每条笔记生成「仅标题」的唯一文件名（不含数字 ID）；重名时加 _2、_3。
 */
function buildIdToUniqueBasename(items: NoteListItem[]): Map<number, string> {
	const result = new Map<number, string>();
	const countByBase = new Map<string, number>();
	for (const item of items) {
		const id = resolveListNoteId(item);
		if (id === undefined) continue;
		const raw = sanitizeFileName(item.title || "未命名");
		const n = countByBase.get(raw) ?? 0;
		countByBase.set(raw, n + 1);
		const unique = n === 0 ? raw : `${raw}_${n + 1}`;
		result.set(id, unique);
	}
	return result;
}

/** 由笔记 ID 与映射生成 Vault 内 .md 路径（文件名为纯标题侧 basename） */
function notePathFromBasename(folder: string, basename: string): string {
	return normalizePath(`${folder.replace(/\/$/, "")}/${basename}.md`);
}

/**
 * 从 Get / biji 的 URL 中尽量解析出笔记数字 ID（用于转成 Vault 内双链）。
 */
function extractNoteIdFromBijiUrl(url: string): number | undefined {
	const patterns: RegExp[] = [
		/[?&#]note[_-]?id=(\d+)/i,
		/[?&#]noteId=(\d+)/i,
		/[?&#]id=(\d+)/i,
		/\/note[s]?\/(\d+)/i,
		/\/n\/(\d+)/i,
		/\/p\/(\d+)/i,
	];
	for (const re of patterns) {
		const m = re.exec(url);
		if (m?.[1]) {
			const n = Number.parseInt(m[1], 10);
			if (Number.isFinite(n)) return n;
		}
	}
	return undefined;
}

/**
 * 把正文里的 Get 笔记网页链接改成 Obsidian 双链（指向本次同步目录下的对应标题文件）。
 */
function rewriteBijiNoteLinksToWiki(
	text: string,
	idToBasename: Map<number, string>,
	folder: string,
): string {
	if (!text.trim()) return text;
	const folderSeg = folder.replace(/^\/+|\/+$/g, "");

	const toWiki = (id: number): string | null => {
		const base = idToBasename.get(id);
		if (!base) return null;
		const inner = normalizePath(`${folderSeg}/${base}`);
		return `[[${inner}]]`;
	};

	let out = text;

	// HTML 外链：<a href="https://...biji...">文字</a> → 双链
	out = out.replace(
		/<a[^>\s]*\s+href=["'](https?:\/\/[^"']*biji\.com[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_full, url: string, innerHtml: string) => {
			const id = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
			if (id === undefined) return _full;
			const w = toWiki(id);
			if (!w) return _full;
			const inner = w.slice(2, -2);
			const label = innerHtml.replace(/<[^>]+>/g, "").trim();
			return label ? `[[${inner}|${label}]]` : `[[${inner}]]`;
		},
	);

	// Markdown 链接：[文字](https://...biji...note...) → [[文件夹/标题|文字]]
	out = out.replace(
		/\[([^\]]*)\]\((https?:\/\/[^)\s]+biji\.com[^)\s]*)\)/gi,
		(_full, label: string, url: string) => {
			const id = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
			if (id === undefined) return _full;
			const w = toWiki(id);
			if (!w) return _full;
			const inner = w.slice(2, -2);
			return label ? `[[${inner}|${label}]]` : `[[${inner}]]`;
		},
	);

	// 裸露的 biji 笔记 URL → 双链（避免已替换的 [[ 内再匹配）
	out = out.replace(/https?:\/\/[^\s"'<>)\]]+biji\.com[^\s"'<>)\]]+/gi, (url) => {
		if (url.includes("]]")) return url;
		const id = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
		if (id === undefined) return url;
		const w = toWiki(id);
		return w ?? url;
	});

	return out;
}

/** 详情接口报错「笔记不存在」等时，用列表项生成内容（列表里通常已有正文摘要） */
function isNoteMissingDetailError(message: string): boolean {
	return (
		/不存在|未找到|找不到/i.test(message) ||
		/not\s*found|note_not_found|NOTE_NOT_FOUND/i.test(message)
	);
}

/** 限流 / 429 等：用列表数据兜底，避免整条同步失败 */
function isRateLimitedMessage(message: string): boolean {
	return /429|限流|太频繁|too many|rate.?limit|多次仍返回 429/i.test(message);
}

/**
 * 拉取详情；失败且像「笔记不存在」或仍限流时退回列表字段并补全 id。
 */
async function fetchDetailOrFallback(
	client: GetNoteApiClient,
	noteId: number,
	item: NoteListItem,
): Promise<NoteDetail> {
	try {
		return await client.getNote(noteId);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		if (isNoteMissingDetailError(msg) || isRateLimitedMessage(msg)) {
			console.warn("[getbiji] 详情不可用，已用列表数据代替：", msg);
			return { ...item, id: noteId } as NoteDetail;
		}
		throw e;
	}
}

const MAX_LIST_PAGES = 5000;

/**
 * 分页拉取当前游标之后的全部列表项（与原先「边拉边写」的列表阶段等价）。
 */
async function collectAllListPages(
	client: GetNoteApiClient,
	startSince: number,
	gapMs: number,
	isCancelled: () => boolean,
	onPage: (pageIndex: number, lastBatch: number, total: number) => void | Promise<void>,
): Promise<{ items: NoteListItem[]; endSince: number; cancelled: boolean }> {
	const items: NoteListItem[] = [];
	let since = startSince;
	let pageIndex = 0;

	for (let guard = 0; guard < MAX_LIST_PAGES; guard++) {
		if (isCancelled()) {
			return { items, endSince: since, cancelled: true };
		}

		const list = await client.listNotes(since);
		await sleep(Math.min(300, gapMs));
		const notes = list.notes ?? [];

		if (notes.length === 0) {
			if (!list.has_more) {
				return { items, endSince: since, cancelled: false };
			}
			since = typeof list.next_cursor === "number" ? list.next_cursor : since;
			continue;
		}

		pageIndex += 1;
		items.push(...notes);
		await onPage(pageIndex, notes.length, items.length);

		const idNums = notes.map((n) => resolveListNoteId(n)).filter((x): x is number => x !== undefined);
		const maxFromBatch = idNums.length > 0 ? Math.max(...idNums) : since;

		if (!list.has_more) {
			const endSince = typeof list.next_cursor === "number" ? list.next_cursor : maxFromBatch;
			return { items, endSince, cancelled: false };
		}

		since = typeof list.next_cursor === "number" ? list.next_cursor : maxFromBatch;
	}

	throw new Error("列表分页超过安全上限，请向官方反馈或缩小同步范围。");
}

/**
 * 执行一次同步：先拉完整列表并显示进度，再逐条写入，全程在弹窗中展示进度。
 */
export async function runSync(plugin: GetNotesPluginLike): Promise<void> {
	const { clientId, apiKey, folderPath, authUseRawKey, requestGapMs } = plugin.settings;
	const gapMs = Number.isFinite(requestGapMs) ? Math.min(5000, Math.max(0, requestGapMs)) : 600;
	if (!clientId.trim() || !apiKey.trim()) {
		new Notice("请先在设置中填写 Client ID 与 API Key。");
		return;
	}

	const folder = folderPath.trim() || "GetBiji";
	await ensureFolder(plugin.app.vault, folder);

	const client = new GetNoteApiClient(apiKey.trim(), clientId.trim(), authUseRawKey);
	const since = plugin.settings.sinceId;

	const modal = new SyncProgressModal(plugin.app);
	modal.open();
	await modal.flush();

	try {
		const collected = await collectAllListPages(
			client,
			since,
			gapMs,
			() => modal.cancelled,
			async (pageIndex, lastBatch, total) => {
				modal.setListFetching(pageIndex, lastBatch, total);
				await modal.flush();
			},
		);

		if (collected.cancelled) {
			modal.setDone("已取消（未更新列表游标）。");
			await modal.flush();
			new Notice("已取消同步。");
			return;
		}

		const { items, endSince } = collected;

		if (items.length === 0) {
			modal.setDone("没有可同步的笔记（列表为空）。可将游标重置为 0 后重试。");
			await modal.flush();
			new Notice(
				"当前没有可同步的笔记（列表为空）。若你确认云端有笔记，请在设置中将「列表游标」重置为 0 后重试。",
				10000,
			);
			return;
		}

		modal.startItemPhase(items.length);
		await modal.flush();

		// 整批笔记的 id→文件名（纯标题），供路径命名与正文内 biji 链接改写为 Obsidian 双链
		const idToBasename = buildIdToUniqueBasename(items);

		let imported = 0;
		for (let i = 0; i < items.length; i++) {
			if (modal.cancelled) {
				modal.setDone(`已取消。已完成 ${imported} / ${items.length} 条（未更新列表游标）。`);
				await modal.flush();
				new Notice(`已取消同步，已处理 ${imported} 条。`);
				return;
			}

			const item = items[i]!;
			const noteId = resolveListNoteId(item);
			if (noteId === undefined) {
				console.warn("[getbiji] 列表项缺少 id 字段，已跳过", item);
				continue;
			}

			modal.setItemProgress(i + 1, items.length, item.title ?? "");
			await modal.flush();

			const detail = await fetchDetailOrFallback(client, noteId, item);
			const basename = idToBasename.get(noteId) ?? sanitizeFileName(item.title || "未命名");
			const path = notePathFromBasename(folder, basename);
			const markdown = noteDetailToMarkdown(detail, { idToBasename, folder });
			const existing = plugin.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await plugin.app.vault.modify(existing, markdown);
			} else {
				await plugin.app.vault.create(path, markdown);
			}
			imported += 1;

			if (gapMs > 0) {
				await sleep(gapMs);
			}
		}

		plugin.settings.sinceId = typeof endSince === "number" ? endSince : since;
		await plugin.saveSettings();

		modal.setDone(`完成：已写入或更新 ${imported} 条。`);
		await modal.flush();
		await sleep(600);
		new Notice(`同步完成：已写入或更新 ${imported} 条笔记。`);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("[getbiji]", e);
		modal.setDone(`失败：${msg}`);
		await modal.flush();
		new Notice(`同步失败：${msg}`, 8000);
		throw e;
	} finally {
		modal.close();
	}
}
