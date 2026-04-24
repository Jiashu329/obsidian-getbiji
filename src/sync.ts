import { App, normalizePath, Notice, TFile } from "obsidian";
import {
	GetNoteApiClient,
	resolveListNoteIdString,
	type NoteDetail,
	type NoteListItem,
} from "./get-api";
import type { GetNotesPluginLike } from "./context";
import { KnowledgeBaseSyncOptions, SyncOptions, SyncProgressModal } from "./sync-ui";

/** 同步过程中在两次网络请求之间暂停，减轻 429 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 扫描全库 Markdown，收集 YAML 中的 get_note_id（字符串，兼容大整数）。
 */
/**
 * 扫描全库 Markdown，收集 YAML 中的 get_note_id（字符串，兼容大整数）。
 * 返回 Map: get_note_id -> TFile 对象
 */
function collectLocalGetNoteMap(app: App): Map<string, TFile> {
	const idMap = new Map<string, TFile>();
	for (const f of app.vault.getMarkdownFiles()) {
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
		if (digitStr !== undefined) idMap.set(digitStr, f);
	}
	return idMap;
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
	return `  - ${JSON.stringify(s)}`;
}

/** YAML 双引号标量（frontmatter 内一行值） */
function yamlQuotedScalar(s: string): string {
	return JSON.stringify(s);
}

/** 附件里 type=link 时，用 API 的 title + url 拼成 Markdown 链接文案 `[title](url)` */
function attachmentToMarkdownLink(a: { type?: string; title?: string; url: string }): string {
	let t = (a.title ?? "").replace(/\r?\n|\r/g, " ").trim();
	if (t.length === 0 && a.type?.toLowerCase() === "audio") {
		t = "录像文/音频";
	}
	return t.length > 0 ? `[${t}](${a.url})` : `[](${a.url})`;
}

/**
 * 将**第一条** `type` 为 link 或 audio 的附件写到 frontmatter 顶层 `Link: "[title](url)"`。
 * 同一条不再写入 `get_note_attachments`，避免与顶层重复。
 */
function linkAttachmentsToRootYaml(attachments: NonNullable<NoteDetail["attachments"]>): string[] {
	const first = attachments.find((a) => a.type?.toLowerCase() === "link" || a.type?.toLowerCase() === "audio");
	if (!first) {
		return [];
	}
	return [`Link: ${yamlQuotedScalar(attachmentToMarkdownLink(first))}`];
}

/**
 * 将附件写入 `get_note_attachments`。
 * 将用于顶层 Link 的首调 link/audio 剔除。剩余的 attachment 中，剔除所有的 link，保留其他类型。
 */
function attachmentsToYamlBlock(attachments: NonNullable<NoteDetail["attachments"]>): string[] {
	const firstTargetIdx = attachments.findIndex((a) => a.type?.toLowerCase() === "link" || a.type?.toLowerCase() === "audio");
	const rest =
		firstTargetIdx >= 0 ? attachments.filter((_, i) => i !== firstTargetIdx) : [...attachments];
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
	canonicalIdStr?: string;
}



/**
 * 按照 Obsidian 规范清理标签：
 * - 允许：字母（包括所有语言）、数字、_、-、/
 * - 替换空格为 `-`
 * - 去除不支持的标点符号
 * - 若最终全部是数字，补充前缀 `tag-`
 */
function sanitizeObsidianTag(tagRaw: string): string {
	let s = tagRaw.trim();
	if (!s) return "";
	
	// 1. 特殊符号可读性容错转移
	s = s.replace(/C\+\+/ig, "Cpp");
	s = s.replace(/\+/g, "plus");
	s = s.replace(/&/g, "and");
	
	// 2. 空格一律变横线
	s = s.replace(/\s+/g, "-");
	
	// 3. 剥离所有 Obsidian 不支持的字符 (利用 Unicode 属性 \p{L} \p{N})
	s = s.replace(/[^\p{L}\p{N}_/-]/gu, "");
	
	// 4. 收尾清理首尾无效横线或斜杠
	s = s.replace(/^[-/]+|[-/]+$/g, "");
	
	// 5. Obsidian 规定标签不能全是数字
	if (/^[0-9]+$/.test(s)) {
		s = `tag-${s}`;
	}
	return s;
}

/**
 * 将一条 Get 笔记详情转为 Markdown 文本（含 YAML frontmatter）。
 * 若传入 idToBasename + folder，会把正文 / 引用里指向 biji 的笔记 URL 转为 `[[同步目录/标题]]`。
 */
export function noteDetailToMarkdown(note: NoteDetail, opt?: NoteMarkdownOptions): string {
	const tagNames = (note.tags ?? [])
		.map((t) => t.name)
		.filter((t): t is string => typeof t === "string")
		.map(sanitizeObsidianTag)
		.filter(Boolean);

	const idForYaml = opt?.canonicalIdStr ?? String(note.id);



	const tagsBlock =
		tagNames.length > 0 ? ["tags:", ...tagNames.map(yamlListItem)] : ["tags: []"];
	const linkRoot =
		note.attachments && note.attachments.length > 0 ? linkAttachmentsToRootYaml(note.attachments) : [];
	const attBlock =
		note.attachments && note.attachments.length > 0 ? attachmentsToYamlBlock(note.attachments) : [];

	const fm = [
		"---",
		`get_note_id: "${idForYaml}"`,
		`title: ${JSON.stringify(note.title ?? "")}`,
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

/** 分页抓取知识库笔记列表 (page-based) */
async function collectAllKnowledgeNotes(
	client: GetNoteApiClient,
	topicId: string,
	gapMs: number,
	isCancelled: () => boolean,
	onPage: (batchIndex: number, lastBatch: number, total: number) => void | Promise<void>,
): Promise<{ items: NoteListItem[]; cancelled: boolean }> {
	const items: NoteListItem[] = [];
	const seenNoteIds = new Set<string>();

	for (let page = 1; page <= 1000; page++) {
		if (isCancelled()) return { items, cancelled: true };

		const list = await client.listKnowledgeNotes(topicId, page);
		const notes = list.notes ?? [];
		if (notes.length === 0) break;

		let added = 0;
		for (const n of notes) {
			const id = resolveListNoteIdString(n);
			if (id && !seenNoteIds.has(id)) {
				seenNoteIds.add(id);
				items.push(n);
				added++;
			}
		}

		await onPage(page, added, items.length);
		if (!list.has_more) break;
		await sleep(Math.min(300, gapMs));
	}

	return { items, cancelled: false };
}

/**
 * 执行通用同步流水线：过滤、逐条拉详情写入、生成报告。
 */
async function performSyncPipeline(
	plugin: GetNotesPluginLike,
	client: GetNoteApiClient,
	modal: SyncProgressModal,
	items: NoteListItem[],
	options: SyncOptions,
	folder: string,
	gapMs: number,
) {
	const { afterDate, forceUpdate, mode } = options;

	// 1. 时间过滤
	if (afterDate !== undefined) {
		items = items.filter((it) => {
			const up = it.updated_at ? new Date(it.updated_at).getTime() : 0;
			return up >= afterDate;
		});
	}

	if (items.length === 0) {
		modal.setDone("没有可同步的笔记（列表为空或不满足时间筛选）。");
		await modal.flush();
		new Notice("没有满足条件的笔记需要同步。");
		return;
	}

	modal.startItemPhase(items.length);
	await modal.flush();

	// 2. 识别本地已有笔记
	const localFileMap = collectLocalGetNoteMap(plugin.app);
	const idToBasename = buildIdToUniqueBasename(items);

	let imported = 0;
	let skipped = 0;
	const writtenTitles: string[] = [];
	const skippedTitles: string[] = [];

	for (let i = 0; i < items.length; i++) {
		if (modal.cancelled) {
			modal.setDone(`已取消。已写入 ${imported} 条，已跳过 ${skipped} 条。`);
			await modal.flush();
			return;
		}

		const item = items[i]!;
		const noteIdStr = resolveListNoteIdString(item);
		if (!noteIdStr) continue;

		const titleStr = item.title?.trim() || "未命名";
		const existingFile = localFileMap.get(noteIdStr);

		if (mode === "incremental" && !forceUpdate && existingFile) {
			skipped++;
			skippedTitles.push(titleStr);
			modal.setItemProgress(i + 1, items.length, `[已存在跳过] ${titleStr}`);
			await modal.flush();
			continue;
		}

		modal.setItemProgress(i + 1, items.length, `${existingFile ? "[更新]" : "[创建]"} ${titleStr}`);
		await modal.flush();

		try {
			const detail = await fetchDetailOrFallback(client, noteIdStr, item);
			const basename = idToBasename.get(noteIdStr) ?? sanitizeFileName(item.title || "未命名");
			const markdown = noteDetailToMarkdown(detail, { idToBasename, folder, canonicalIdStr: noteIdStr });

			if (existingFile) {
				await plugin.app.vault.modify(existingFile, markdown);
				const newName = `${basename}.md`;
				if (existingFile.name !== newName) {
					const newPath = normalizePath(`${existingFile.parent?.path}/${newName}`);
					if (!plugin.app.vault.getAbstractFileByPath(newPath)) {
						await plugin.app.vault.rename(existingFile, newPath);
					}
				}
			} else {
				const path = notePathFromBasename(folder, basename);
				await plugin.app.vault.create(path, markdown);
			}

			imported++;
			writtenTitles.push(titleStr);
		} catch (e) {
			console.error(`[getbiji] 同步笔记 ${titleStr} 失败:`, e);
		}

		if (gapMs > 0) await sleep(gapMs);
	}

	// 3. 生成同步报告
	try {
		const reportLines = [
			`# Getbiji 同步报告`,
			`时间：${new Date().toLocaleString()}`,
			`存放：${folder}`,
			`模式：${mode === "incremental" ? "增量" : "全量"}`,
			`成功的：${imported} 条`,
			`挑过的：${skipped} 条`,
			"",
			"## 同步详情",
			...writtenTitles.map(t => `- [x] ${t}`),
			...skippedTitles.map(t => `- [ ] ${t} (已存在)`),
		];
		const reportPath = normalizePath(`${folder}/同步报告-${Date.now()}.md`);
		await plugin.app.vault.create(reportPath, reportLines.join("\n"));
	} catch (e) {
		console.error("生成报告失败", e);
	}

	modal.setDone(`同步完成！写入 ${imported} 条，跳过 ${skipped} 条。`);
	await modal.flush();
	new Notice(`同步完成：写入 ${imported} 条。`);
}

/**
 * 全集同步入口
 */
export async function runSync(plugin: GetNotesPluginLike, options: SyncOptions): Promise<void> {
	const { clientId, apiKey, folderPath, authUseRawKey, requestGapMs } = plugin.settings;
	if (!clientId.trim() || !apiKey.trim()) {
		new Notice("请先配置 Client ID 和 API key。");
		return;
	}

	const folder = folderPath.trim() || "GetBiji";
	await ensureFolder(plugin.app.vault, folder);
	const client = new GetNoteApiClient(apiKey.trim(), clientId.trim(), authUseRawKey);
	const modal = new SyncProgressModal(plugin.app, plugin.statusBarItem);
	
	plugin.activeSync = { modal, promise: (async () => {})() };
	modal.open();

	const syncPromise = (async () => {
		try {
			const collected = await collectAllListPages(client, 0, 600, () => modal.cancelled, (idx, last, tot) => {
				modal.setListFetching(idx, last, tot);
			});
			if (collected.cancelled) return;
			await performSyncPipeline(plugin, client, modal, collected.items, options, folder, requestGapMs);
		} catch (e) {
			new Notice("同步出错: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			plugin.activeSync = null;
			modal.close();
		}
	})();

	plugin.activeSync.promise = syncPromise;
	await syncPromise;
}

/**
 * 知识库同步入口
 */
export async function runKnowledgeBaseSync(plugin: GetNotesPluginLike, options: KnowledgeBaseSyncOptions): Promise<void> {
	const { clientId, apiKey, folderPath, authUseRawKey, requestGapMs } = plugin.settings;
	if (!clientId.trim() || !apiKey.trim()) {
		new Notice("请先配置同步信息。");
		return;
	}

	// 知识库存放在子目录：GetBiji/知识库名称
	const baseFolder = folderPath.trim() || "GetBiji";
	const targetFolder = normalizePath(`${baseFolder}/${sanitizeFileName(options.topicName)}`);
	await ensureFolder(plugin.app.vault, targetFolder);

	const client = new GetNoteApiClient(apiKey.trim(), clientId.trim(), authUseRawKey);
	const modal = new SyncProgressModal(plugin.app, plugin.statusBarItem);
	
	plugin.activeSync = { modal, promise: (async () => {})() };
	modal.open();

	const syncPromise = (async () => {
		try {
			const collected = await collectAllKnowledgeNotes(client, options.topicId, 600, () => modal.cancelled, (idx, last, tot) => {
				modal.setListFetching(idx, last, tot);
			});
			if (collected.cancelled) return;
			await performSyncPipeline(plugin, client, modal, collected.items, options, targetFolder, requestGapMs);
		} catch (e) {
			new Notice("知识库同步出错: " + (e instanceof Error ? e.message : String(e)));
		} finally {
			plugin.activeSync = null;
			modal.close();
		}
	})();

	plugin.activeSync.promise = syncPromise;
	await syncPromise;
}
