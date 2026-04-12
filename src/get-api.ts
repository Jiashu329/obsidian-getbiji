import { requestUrl } from "obsidian";

/** Get 开放平台 OpenAPI v1 根路径（与官方文档一致） */
export const GET_NOTE_API_BASE = "https://openapi.biji.com/open/api/v1";

/** 列表单项（与接口字段对齐的最小类型） */
export interface TagInfo {
	id: string;
	name: string;
}

export interface NoteListItem {
	id: number;
	title: string;
	content: string;
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
	next_cursor?: number;
	total: number;
}

/** 详情中的笔记（在 note 字段内） */
export interface NoteDetail extends NoteListItem {
	ref_content?: string;
	attachments?: { type: string; url: string; title?: string }[];
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
 * 封装 Get 笔记 HTTP 调用：统一鉴权头与 `{ success, data }` 解析。
 * 鉴权方式：Authorization: Bearer <API Key>，以及 X-Client-ID（与开放平台示例一致）。
 */
export class GetNoteApiClient {
	constructor(
		private readonly apiKey: string,
		private readonly clientId: string,
	) {}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"X-Client-ID": this.clientId,
			"Content-Type": "application/json",
		};
	}

	private async getJson<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
		const qs = new URLSearchParams();
		for (const [k, v] of Object.entries(query)) {
			if (v === undefined) continue;
			qs.set(k, String(v));
		}
		const url = `${GET_NOTE_API_BASE}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;
		const res = await requestUrl({ url, method: "GET", headers: this.headers() });
		const body = res.json as ApiEnvelope<T>;
		if (!body.success || body.data === undefined) {
			const msg = body.error?.message ?? "Get API 返回失败";
			const reason = body.error?.reason ?? "";
			throw new Error(reason ? `${msg} (${reason})` : msg);
		}
		return body.data;
	}

	/** 分页列举笔记，`since_id` 为游标（首次可用 0） */
	async listNotes(sinceId: number): Promise<ListNotesData> {
		return this.getJson<ListNotesData>("/resource/note/list", { since_id: sinceId });
	}

	/** 拉取单条笔记详情（正文更完整） */
	async getNote(noteId: number): Promise<NoteDetail> {
		const data = await this.getJson<{ note: NoteDetail }>("/resource/note/detail", { id: noteId });
		return data.note;
	}
}
