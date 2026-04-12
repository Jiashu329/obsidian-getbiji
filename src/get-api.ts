import { requestUrl } from "obsidian";

/** Get 开放平台 OpenAPI v1 根路径（与官方文档一致） */
export const GET_NOTE_API_BASE = "https://openapi.biji.com/open/api/v1";

/** 简单延迟，用于限流退避 */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 解析响应头 Retry-After（秒），若无或无效则返回 undefined */
function parseRetryAfterSeconds(headers: Record<string, string>): number | undefined {
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== "retry-after") continue;
		const sec = Number.parseInt(String(value).trim(), 10);
		return Number.isFinite(sec) && sec >= 0 ? sec : undefined;
	}
	return undefined;
}

/** 列表单项（与接口字段对齐的最小类型） */
export interface TagInfo {
	id: string;
	name: string;
}

export interface NoteListItem {
	/** 笔记 ID（接口可能只返回其一） */
	id?: number;
	note_id?: number;
	title: string;
	content: string;
	/** 引用/关联片段（部分 AI 笔记会放在此字段） */
	ref_content?: string;
	/** 部分列表接口也会带附件；详情失败兜底合并时可保留 */
	attachments?: { type: string; url: string; title?: string; size?: number; duration?: number }[];
	note_type: string;
	source: string;
	tags: TagInfo[];
	created_at: string;
	updated_at: string;
}

/** 列表接口返回的 data 部分 */
export interface ListNotesData {
	notes: NoteListItem[];
	has_more: boolean;
	/** 下一页游标（部分环境下可能是字符串数字，需在同步逻辑中统一解析） */
	next_cursor?: number | string;
	total: number;
}

/** 详情中的笔记（在 note 字段内）；`id` 在详情中通常必有 */
export interface NoteDetail extends NoteListItem {
	id: number;
	ref_content?: string;
	attachments?: { type: string; url: string; title?: string; size?: number; duration?: number }[];
	web_page?: { url: string; domain?: string; excerpt?: string; content?: string };
	audio?: { play_url?: string; duration?: number; original?: string };
}

interface ApiEnvelope<T> {
	success: boolean;
	data?: T;
	error?: { code: number; message: string; reason: string };
	request_id?: string;
}

/**
 * 解析为无损十进制字符串（用于列表游标、超大 snowflake ID）；JSON number 若已超过安全整数则无法还原，返回 undefined。
 */
export function resolveListNoteIdString(item: NoteListItem): string | undefined {
	const ext = item as NoteListItem & { noteId?: unknown; resource_id?: unknown };
	const candidates = [ext.noteId, item.note_id, ext.resource_id, item.id];
	
	for (const raw of candidates) {
		if (raw === undefined || raw === null) continue;
		if (typeof raw === "bigint") return raw.toString();
		if (typeof raw === "string") {
			const t = raw.trim();
			if (!/^\d+$/.test(t)) continue;
			try {
				return BigInt(t).toString();
			} catch {
				continue;
			}
		}
		if (typeof raw === "number" && Number.isFinite(raw)) {
			if (Number.isSafeInteger(raw)) return String(raw);
			// 如果是不安全的整数（精度丢失），忽略它并尝试下一个候选字段
		}
	}
	return undefined;
}

/**
 * 仅当 ID 可安全放入 JS number 时返回（否则请用 resolveListNoteIdString + 字符串 API）。
 */
export function resolveListNoteId(item: NoteListItem): number | undefined {
	const s = resolveListNoteIdString(item);
	if (s === undefined) return undefined;
	try {
		const b = BigInt(s);
		const n = Number(b);
		if (!Number.isSafeInteger(n) || BigInt(n) !== b) return undefined;
		return n;
	} catch {
		return undefined;
	}
}

/**
 * 封装 Get 笔记 HTTP 调用：统一鉴权头与 `{ success, data }` 解析。
 * 鉴权：优先使用 `Bearer`（与社区 SDK 一致）；若开放平台仅支持裸 Key，可改用原始 Key。
 */
export class GetNoteApiClient {
	constructor(
		private readonly apiKey: string,
		private readonly clientId: string,
		private readonly authRawKey: boolean = false,
	) {}

	private headers(): Record<string, string> {
		const auth = this.authRawKey ? this.apiKey : `Bearer ${this.apiKey}`;
		return {
			Authorization: auth,
			"X-Client-ID": this.clientId,
			"Content-Type": "application/json",
		};
	}

	/**
	 * 发起 GET 并解析 `{ success, data, error }`。
	 * 对 HTTP 429 做有限次退避重试（避免短时间连续请求触发限流）。
	 */
	private async getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined) continue;
			qs.set(k, String(v));
		}
		const url = `${GET_NOTE_API_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
		const maxAttempts = 6;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			const res = await requestUrl({
				url,
				method: "GET",
				headers: this.headers(),
				throw: false,
			});

			if (res.status === 429) {
				const fromHeader = parseRetryAfterSeconds(res.headers);
				const backoffSec = Math.min(60, 1 * 2 ** attempt);
				const waitMs = (fromHeader ?? backoffSec) * 1000 + Math.floor(Math.random() * 250);
				console.warn(`[getbiji] HTTP 429，${Math.round(waitMs / 1000)}s 后重试 (${attempt + 1}/${maxAttempts})`);
				await sleep(waitMs);
				continue;
			}

			if (res.status < 200 || res.status >= 300) {
				throw new Error(`HTTP ${res.status}`);
			}

			const body = res.json as ApiEnvelope<T>;
			if (!body.success || body.data === undefined) {
				const msg = body.error?.message ?? "Get API 请求失败";
				const reason = body.error?.reason ?? "";
				const rate = /429|too many|频率|限流|quota|rate/i.test(`${msg} ${reason}`);
				if (rate && attempt < maxAttempts - 1) {
					const waitMs = Math.min(60_000, 1500 * 2 ** attempt) + Math.floor(Math.random() * 300);
					console.warn(`[getbiji] 接口限流提示，${Math.round(waitMs / 1000)}s 后重试`);
					await sleep(waitMs);
					continue;
				}
				throw new Error(reason ? `${msg}（${reason}）` : msg);
			}
			return body.data;
		}
		throw new Error("请求多次仍返回 429，请稍后再试或降低同步频率。");
	}

	/** 分页列举笔记，`since_id` 为游标（首次可用 0 或 "0"，大 ID 务必用字符串） */
	async listNotes(sinceId: number | string): Promise<ListNotesData> {
		return this.getJson<ListNotesData>("/resource/note/list", { since_id: sinceId });
	}

	/** 拉取单条笔记详情（正文更完整）；参数用字符串避免大数精度问题 */
	async getNote(noteId: number | string): Promise<NoteDetail> {
		const data = await this.getJson<{ note: NoteDetail }>("/resource/note/detail", {
			id: String(noteId),
		});
		return data.note;
	}
}
