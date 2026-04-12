import { App, normalizePath, Notice, TFile } from "obsidian";
import {
	GetNoteApiClient,
	resolveListNoteIdString,
	type NoteDetail,
	type NoteListItem,
} from "./get-api";
import type { GetNotesPluginLike } from "./context";
import { SyncProgressModal } from "./sync-ui";

/** 同步过程中在两次网络请求之间暂停，减轻 429 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 扫描同步目录下 Markdown，收集 YAML 中的 get_note_id（字符串，兼容大整数）。
 */
function collectLocalGetNoteIds(app: App, folderRaw: string): Set<string> {
	const folderNorm = normalizePath(folderRaw.trim() || "GetBiji");
	const prefix = `${folderNorm}/`;
	const ids = new Set<string>();
	for (const f of app.vault.getMarkdownFiles()) {
		const p = normalizePath(f.path);
		if (!p.startsWith(prefix)) continue;
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (fm == null) continue;
		const raw = fm["get_note_id"] as unknown;
		let digitStr: string | undefined;
		if (typeof raw === "string") {
			const t = raw.trim();
			if (/^\d+$/.test(t)) digitStr = BigInt(t).toString();
		} else if (typeof raw === "number" && Number.isFinite(raw) && Number.isSafeInteger(raw)) {
			digitStr = BigInt(Math.trunc(raw)).toString();
		}
		if (digitStr !== undefined) ids.add(digitStr);
	}
	return ids;
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
	idToBasename?: Map<string, string>;
	folder?: string;
	/** 写入 YAML 的 get_note_id（大整数用此避免 JSON number 丢精度） */
	canonicalIdStr?: string;
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
	const idForYaml = opt?.canonicalIdStr ?? String(note.id);
	const fm = [
		"---",
		`get_note_id: ${idForYaml}`,
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
function buildIdToUniqueBasename(items: NoteListItem[]): Map<string, string> {
	const result = new Map<string, string>();
	const countByBase = new Map<string, number>();
	for (const item of items) {
		const id = resolveListNoteIdString(item);
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
 * 从 Get / biji 的 URL 中解析笔记 ID 十进制字符串（支持超长 snowflake）。
 */
function extractNoteIdFromBijiUrl(url: string): string | undefined {
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
		const digits = m?.[1];
		if (digits && /^\d+$/.test(digits)) {
			try {
				return BigInt(digits).toString();
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * 把正文里的 Get 笔记网页链接改成 Obsidian 双链（指向本次同步目录下的对应标题文件）。
 */
function rewriteBijiNoteLinksToWiki(
	text: string,
	idToBasename: Map<string, string>,
	folder: string,
): string {
	if (!text.trim()) return text;
	const folderSeg = folder.replace(/^\/+|\/+$/g, "");

	const toWiki = (idStr: string): string | null => {
		const base = idToBasename.get(idStr);
		if (!base) return null;
		const inner = normalizePath(`${folderSeg}/${base}`);
		return `[[${inner}]]`;
	};

	let out = text;

	// HTML 外链：<a href="https://...biji...">文字</a> → 双链
	out = out.replace(
		/<a[^>\s]*\s+href=["'](https?:\/\/[^"']*biji\.com[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
		(_full, url: string, innerHtml: string) => {
			const idStr = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
			if (idStr === undefined) return _full;
			const w = toWiki(idStr);
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
			const idStr = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
			if (idStr === undefined) return _full;
			const w = toWiki(idStr);
			if (!w) return _full;
			const inner = w.slice(2, -2);
			return label ? `[[${inner}|${label}]]` : `[[${inner}]]`;
		},
	);

	// 裸露的 biji 笔记 URL → 双链（避免已替换的 [[ 内再匹配）
	out = out.replace(/https?:\/\/[^\s"'<>)\]]+biji\.com[^\s"'<>)\]]+/gi, (url) => {
		if (url.includes("]]")) return url;
		const idStr = extractNoteIdFromBijiUrl(url.replace(/&amp;/g, "&"));
		if (idStr === undefined) return url;
		const w = toWiki(idStr);
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
	noteIdStr: string,
	item: NoteListItem,
): Promise<NoteDetail> {
	try {
		return await client.getNote(noteIdStr);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		if (isNoteMissingDetailError(msg) || isRateLimitedMessage(msg)) {
			console.warn("[getbiji] 详情不可用，已用列表数据代替：", msg);
			let idNum = 0;
			try {
				const b = BigInt(noteIdStr);
				const n = Number(b);
				if (Number.isSafeInteger(n) && BigInt(n) === b) idNum = n;
			} catch {
				idNum = 0;
			}
			return { ...item, id: idNum } as NoteDetail;
		}
		throw e;
	}
}

const MAX_LIST_PAGES = 5000;

/** 列表分页无法继续（BigInt 回退仍无效时） */
class ListCursorStuckError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ListCursorStuckError";
	}
}

/**
 * 将接口返回的 next_cursor 规范为十进制字符串（不信任已损的 JSON number）。
 */
function parseCursorDecimalString(raw: unknown): string | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw === "bigint") return raw.toString();
	if (typeof raw === "string") {
		const t = raw.trim();
		if (!/^\d+$/.test(t)) return undefined;
		try {
			return BigInt(t).toString();
		} catch {
			return undefined;
		}
	}
	if (typeof raw === "number" && Number.isFinite(raw)) {
		if (!Number.isSafeInteger(raw)) return undefined;
		return String(raw);
	}
	return undefined;
}

/** 本批列表项中的最大笔记 ID（字符串，BigInt 比较） */
function maxIdStringFromNotes(notes: NoteListItem[]): string | undefined {
	let max: bigint | null = null;
	for (const n of notes) {
		const s = resolveListNoteIdString(n);
		if (s === undefined) continue;
		try {
			const b = BigInt(s);
			if (max === null || b > max) max = b;
		} catch {
			continue;
		}
	}
	return max === null ? undefined : max.toString();
}

/**
 * 接口未给 next_cursor 时的下一 since 候选：与 getnote-mcp 文档一致，优先「本页最后一条」的 ID，否则用本批最大 ID。
 */
function nextSinceCandidateWithoutCursor(notes: NoteListItem[], sinceAtRequest: string): string {
	const last = notes.length > 0 ? resolveListNoteIdString(notes[notes.length - 1]!) : undefined;
	const maxB = maxIdStringFromNotes(notes) ?? sinceAtRequest;
	return last ?? maxB;
}

function normalizeStartSinceString(startSince: number | string): string {
	if (typeof startSince === "string") {
		const t = startSince.trim();
		if (/^\d+$/.test(t)) {
			try {
				return BigInt(t).toString();
			} catch {
				return "0";
			}
		}
		return "0";
	}
	if (typeof startSince === "number" && Number.isFinite(startSince) && Number.isSafeInteger(Math.trunc(startSince))) {
		return String(Math.trunc(startSince));
	}
	return "0";
}

/** 本批列表项中的最小笔记 ID（用于与「ID 递减 / 末条为游标」类接口对齐） */
function minIdStringFromNotes(notes: NoteListItem[]): string | undefined {
	let min: bigint | null = null;
	for (const n of notes) {
		const s = resolveListNoteIdString(n);
		if (s === undefined) continue;
		try {
			const b = BigInt(s);
			if (min === null || b < min) min = b;
		} catch {
			continue;
		}
	}
	return min === null ? undefined : min.toString();
}

/**
 * 分页拉取列表；游标与 ID 一律按十进制字符串 + BigInt 演算，避免超大 snowflake 在 JS 里 since+1 === since。
 * 若接口在 has_more 下重复返回同 ID，会按笔记 ID 去重，并在 total 已收齐时提前结束，避免「只有二十多条却翻几十页」。
 */
async function collectAllListPages(
	client: GetNoteApiClient,
	startSince: number | string,
	gapMs: number,
	isCancelled: () => boolean,
	onPage: (batchIndex: number, lastBatch: number, total: number) => void | Promise<void>,
): Promise<{ items: NoteListItem[]; endSince: string; cancelled: boolean }> {
	const items: NoteListItem[] = [];
	const seenNoteIds = new Set<string>();
	let serverTotal: number | undefined;
	let sinceStr = normalizeStartSinceString(startSince);
	let batchIndex = 0;
	let duplicateOnlyStreak = 0;

	for (let guard = 0; guard < MAX_LIST_PAGES; guard++) {
		if (isCancelled()) {
			return { items, endSince: sinceStr, cancelled: true };
		}

		const sinceAtRequest = sinceStr;
		const list = await client.listNotes(sinceStr);
		await sleep(Math.min(300, gapMs));
		const notes = list.notes ?? [];

		if (typeof list.total === "number" && Number.isFinite(list.total) && list.total >= 0) {
			if (serverTotal === undefined || list.total > serverTotal) {
				serverTotal = list.total;
			}
		}

		const finishIfQuotaMet = (): boolean =>
			serverTotal !== undefined && serverTotal > 0 && seenNoteIds.size >= serverTotal;

		if (notes.length === 0) {
			if (!list.has_more) {
				return { items, endSince: sinceStr, cancelled: false };
			}
			if (finishIfQuotaMet()) {
				return { items, endSince: sinceStr, cancelled: false };
			}
			const nextS = parseCursorDecimalString(list.next_cursor);
			let newS = nextS ?? sinceStr;
			if (newS === sinceAtRequest) {
				newS = (BigInt(sinceAtRequest) + BigInt(1)).toString();
				console.debug("[getbiji] 列表空批仍 has_more，游标完全停滞，强制 since+1 续页", {
					sinceAtRequest,
					nextS,
					newS,
				});
			}
			sinceStr = newS;
			continue;
		}

		let added = 0;
		for (const n of notes) {
			const id = resolveListNoteIdString(n);
			if (id !== undefined && seenNoteIds.has(id)) {
				continue;
			}
			if (id !== undefined) {
				seenNoteIds.add(id);
			}
			items.push(n);
			added += 1;
		}

		if (added === 0 && notes.length > 0) {
			duplicateOnlyStreak += 1;
			if (duplicateOnlyStreak > 25) {
				console.warn(
					"[getbiji] 已连续多批仅重复笔记，停止列表拉取（避免无限翻页）。若笔记未收齐请联系 Get 开放平台核对列表分页。",
					{ uniqueCount: seenNoteIds.size, duplicateOnlyStreak },
				);
				return { items, endSince: sinceStr, cancelled: false };
			}
			const minB = minIdStringFromNotes(notes);
			if (minB !== undefined && BigInt(minB) < BigInt(sinceAtRequest) && BigInt(minB) > BigInt(0)) {
				let tryNext = BigInt(minB) - BigInt(1);
				if (tryNext < BigInt(0)) tryNext = BigInt(0);
				sinceStr = tryNext.toString();
				console.debug("[getbiji] 本批数据均为重复，尝试按照递减趋势向下推进 since", { sinceAtRequest, minB, sinceStr });
			} else {
				sinceStr = (BigInt(sinceAtRequest) + BigInt(1)).toString();
				console.debug("[getbiji] 本批笔记均已出现过，已跳过并入并向上推进 since+1", {
					sinceAtRequest,
					dupStreak: duplicateOnlyStreak,
				});
			}
			continue;
		}
		duplicateOnlyStreak = 0;

		batchIndex += 1;
		await onPage(batchIndex, added, items.length);

		if (finishIfQuotaMet()) {
			return { items, endSince: sinceStr, cancelled: false };
		}

		const maxBatch = maxIdStringFromNotes(notes) ?? sinceAtRequest;
		const minBatch = minIdStringFromNotes(notes) ?? sinceAtRequest;
		const nextS = parseCursorDecimalString(list.next_cursor);

		if (!list.has_more) {
			const endSince = nextS ?? maxBatch;
			return { items, endSince, cancelled: false };
		}

		let newSinceStr =
			nextS !== undefined ? nextS : nextSinceCandidateWithoutCursor(notes, sinceAtRequest);

		if (newSinceStr === sinceAtRequest) {
			const tryMin = minBatch !== maxBatch ? minBatch : undefined;
			const hi =
				BigInt(maxBatch) > BigInt(sinceAtRequest) ? BigInt(maxBatch) : BigInt(sinceAtRequest);
			const bumpMax = (hi + BigInt(1)).toString();
			if (
				tryMin !== undefined &&
				BigInt(tryMin) < BigInt(sinceAtRequest) &&
				BigInt(tryMin) > BigInt(0)
			) {
				newSinceStr = tryMin;
				console.debug(
					"[getbiji] 列表续页卡住：采用本批最小 ID 作为下一 since 脱困（适配「ID 递减」类分页）",
					{ sinceAtRequest, minBatch, maxBatch, newSinceStr },
				);
			} else {
				newSinceStr = bumpMax;
				console.debug("[getbiji] 列表续页卡住：已用 max(since,本批最大ID)+1 作为下一 since 脱困", {
					sinceAtRequest,
					nextS,
					maxBatch,
					newSinceStr,
				});
			}
			if (newSinceStr === sinceAtRequest) {
				throw new ListCursorStuckError("列表游标彻底未前进且脱困失败，无法继续分页。");
			}
		}
		sinceStr = newSinceStr;
	}

	throw new Error("列表分页超过安全上限，请向官方反馈或缩小同步范围。");
}

/**
 * 执行一次同步：先拉完整列表并显示进度，再逐条写入，全程在弹窗中展示进度。
 */
export async function runSync(plugin: GetNotesPluginLike): Promise<void> {
	const { clientId, apiKey, folderPath, authUseRawKey, requestGapMs, syncMode } = plugin.settings;
	const gapMs = Number.isFinite(requestGapMs) ? Math.min(5000, Math.max(0, requestGapMs)) : 600;
	const mode = syncMode === "incremental" ? "incremental" : "full";
	if (!clientId.trim() || !apiKey.trim()) {
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		new Notice("请先在设置中填写 Client ID 与 API key。");
		return;
	}

	const folder = folderPath.trim() || "GetBiji";
	await ensureFolder(plugin.app.vault, folder);

	const client = new GetNoteApiClient(apiKey.trim(), clientId.trim(), authUseRawKey);

	const modal = new SyncProgressModal(plugin.app);
	modal.open();
	await modal.flush();

	try {
		// 不再使用本地 sinceId 游标：列表始终从 since_id=0 分页拉全量目录
		const collected = await collectAllListPages(
			client,
			0,
			gapMs,
			() => modal.cancelled,
			async (batchIndex, lastBatch, total) => {
				modal.setListFetching(batchIndex, lastBatch, total);
				await modal.flush();
			},
		);

		if (collected.cancelled) {
			modal.setDone("已取消。");
			await modal.flush();
			new Notice("已取消同步。");
			return;
		}

		const { items } = collected;

		if (items.length === 0) {
			modal.setDone("没有可同步的笔记（列表为空）。");
			await modal.flush();
			new Notice("当前没有可同步的笔记。若云端确有内容，可稍后再试。", 10000);
			return;
		}

		modal.startItemPhase(items.length);
		await modal.flush();

		// 增量：根据同步目录内已有 get_note_id 决定是否跳过（不拉详情）
		const localIds = mode === "incremental" ? collectLocalGetNoteIds(plugin.app, folder) : null;

		// 整批笔记的 id→文件名（纯标题），供路径命名与正文内 biji 链接改写为 Obsidian 双链
		const idToBasename = buildIdToUniqueBasename(items);

		let imported = 0;
		let skipped = 0;
		for (let i = 0; i < items.length; i++) {
			if (modal.cancelled) {
				modal.setDone(`已取消。已写入 ${imported} 条，已跳过 ${skipped} 条。`);
				await modal.flush();
				new Notice(`已取消同步，已写入 ${imported} 条。`);
				return;
			}

			const item = items[i]!;
			const noteIdStr = resolveListNoteIdString(item);
			if (noteIdStr === undefined) {
				console.warn("[getbiji] 列表项缺少可解析的 id 字段，已跳过", item);
				continue;
			}

			if (mode === "incremental" && localIds !== null && localIds.has(noteIdStr)) {
				skipped += 1;
				modal.setItemProgress(i + 1, items.length, `${item.title ?? ""}（已跳过：本地已有同 ID）`);
				await modal.flush();
				continue;
			}

			modal.setItemProgress(i + 1, items.length, item.title ?? "");
			await modal.flush();

			const detail = await fetchDetailOrFallback(client, noteIdStr, item);
			const basename = idToBasename.get(noteIdStr) ?? sanitizeFileName(item.title || "未命名");
			const path = notePathFromBasename(folder, basename);
			const markdown = noteDetailToMarkdown(detail, {
				idToBasename,
				folder,
				canonicalIdStr: noteIdStr,
			});
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

		const doneDetail =
			skipped > 0 ? `完成：已写入或更新 ${imported} 条，已跳过 ${skipped} 条（本地已有同 ID）。` : `完成：已写入或更新 ${imported} 条。`;
		modal.setDone(doneDetail);
		await modal.flush();
		await sleep(600);
		const noticeMsg =
			skipped > 0
				? `同步完成：已写入或更新 ${imported} 条，已跳过 ${skipped} 条。`
				: `同步完成：已写入或更新 ${imported} 条笔记。`;
		new Notice(noticeMsg);
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
