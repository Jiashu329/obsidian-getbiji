import { normalizePath, Notice, TFile } from "obsidian";
import { GetNoteApiClient, type NoteDetail } from "./get-api";
import type { GetNotesPluginLike } from "./context";

/**
 * 将标题等转为可用于文件名的安全字符串（去掉 Windows/Unix 非法字符）。
 */
function sanitizeFileName(name: string): string {
	const s = name.replace(/[\\/:*?"<>|]/g, "_").trim();
	return s.length > 0 ? s.slice(0, 120) : "untitled";
}

/** YAML 列表项：必要时加引号，避免特殊字符破坏 frontmatter */
function yamlListItem(s: string): string {
	const safe = s.replace(/"/g, '\\"');
	return `  - "${safe}"`;
}

/**
 * 将一条 Get 笔记详情转为 Markdown 文本（含 YAML frontmatter）。
 */
export function noteDetailToMarkdown(note: NoteDetail): string {
	const tagNames = (note.tags ?? []).map((t) => t.name).filter(Boolean);
	const tagsBlock =
		tagNames.length > 0 ? ["tags:", ...tagNames.map(yamlListItem)] : ["tags: []"];
	const fm = [
		"---",
		`get_note_id: ${note.id}`,
		`title: "${(note.title ?? "").replace(/"/g, '\\"')}"`,
		`note_type: ${note.note_type ?? ""}`,
		`source: ${note.source ?? ""}`,
		`updated_at: ${note.updated_at ?? ""}`,
		`created_at: ${note.created_at ?? ""}`,
		...tagsBlock,
		"---",
		"",
	];
	const parts: string[] = [...fm, `# ${note.title || "(无标题)"}`, ""];
	const body = note.content?.trim() || note.ref_content?.trim() || "";
	if (body.length > 0) {
		parts.push(body);
		parts.push("");
	}
	if (note.web_page?.url) {
		parts.push("## 链接", "");
		parts.push(`- 地址: ${note.web_page.url}`);
		if (note.web_page.excerpt) parts.push(`- 摘要: ${note.web_page.excerpt}`);
		if (note.web_page.content) {
			parts.push("", "### 网页正文摘录", "", note.web_page.content);
		}
		parts.push("");
	}
	if (note.attachments && note.attachments.length > 0) {
		parts.push("## 附件", "");
		for (const a of note.attachments) {
			const line = a.title ? `- [${a.title}](${a.url})` : `- ${a.url}`;
			parts.push(line);
		}
		parts.push("");
	}
	if (note.audio?.play_url) {
		parts.push("## 音频", "", `- [播放](${note.audio.play_url})`, "");
	}
	return parts.join("\n");
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

function noteToPath(folder: string, note: NoteDetail): string {
	const base = `${note.id}-${sanitizeFileName(note.title || "note")}.md`;
	return normalizePath(`${folder.replace(/\/$/, "")}/${base}`);
}

/**
 * 执行一次同步：分页拉列表 → 每条拉详情 → 写入/覆盖 Markdown。
 * 冲突策略：同路径文件始终以 Get 侧内容覆盖（MVP）。
 */
export async function runSync(plugin: GetNotesPluginLike): Promise<void> {
	const { clientId, apiKey, folderPath } = plugin.settings;
	if (!clientId.trim() || !apiKey.trim()) {
		new Notice("Add your client ID and API key in settings first.");
		return;
	}
	const folder = folderPath.trim() || "Get-notes";
	await ensureFolder(plugin.app.vault, folder);

	const client = new GetNoteApiClient(apiKey.trim(), clientId.trim());
	let since = plugin.settings.sinceId;
	let imported = 0;

	try {
		for (;;) {
			const list = await client.listNotes(since);
			const notes = list.notes ?? [];
			for (const item of notes) {
				const detail = await client.getNote(item.id);
				const path = noteToPath(folder, detail);
				const markdown = noteDetailToMarkdown(detail);
				const existing = plugin.app.vault.getAbstractFileByPath(path);
				if (existing instanceof TFile) {
					await plugin.app.vault.modify(existing, markdown);
				} else {
					await plugin.app.vault.create(path, markdown);
				}
				imported += 1;
			}

			if (!list.has_more) {
				const lastId =
					list.next_cursor ??
					(notes.length > 0 ? Math.max(...notes.map((n) => n.id)) : since);
				plugin.settings.sinceId = typeof lastId === "number" ? lastId : since;
				break;
			}

			const next =
				list.next_cursor ??
				(notes.length > 0 ? Math.max(...notes.map((n) => n.id)) : since);
			since = typeof next === "number" ? next : since;
		}
		await plugin.saveSettings();
		new Notice(`Sync finished: ${imported} note(s) written or updated.`);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error("[get-notes-sync]", e);
		new Notice(`Sync failed: ${msg}`, 8000);
		throw e;
	}
}
