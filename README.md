# Get Notes Sync（Obsidian 插件）

将 [Get 笔记](https://www.biji.com) 通过[开放平台 API](https://www.biji.com/openapi) 同步到当前 Obsidian 仓库中的 Markdown 文件。

## 功能（MVP）

- 在设置中填写 **Client ID** 与 **API Key**（在开放平台创建应用后获得）。
- 使用命令面板 **「Sync notes from Get」** 或左侧功能区 **云下载图标**，一键拉取笔记并写入指定文件夹。
- 每条笔记生成一个 `.md` 文件，含 YAML 前置元数据（`get_note_id`、标签、时间等）；正文以 Get 返回内容为主。
- **冲突策略**：同一路径文件会被本次同步内容**覆盖**（以云端为准）。
- **增量**：使用列表接口返回的游标更新 `since_id`；若需从头全量再拉一次，可在设置中 **Reset to 0**。

## 开发

```bash
npm install
npm run build
```

开发时可 `npm run dev` 监听构建，将生成的 `main.js`、`manifest.json`、`styles.css` 复制到仓库的 `.obsidian/plugins/get-notes-sync/` 下（或使用官方推荐的符号链接方式）。

## 安全说明

- API Key 仅保存在本机 Obsidian 插件数据（`data.json`，已在 `.gitignore` 中忽略常见敏感文件命名时可配合勿提交）。
- 请勿将密钥提交到 Git 或分享给他人。

## 许可证

与官方示例一致：**0BSD**（见仓库根目录 `LICENSE`）。

## API 参考

- 开放平台：<https://www.biji.com/openapi?tab=docs>
- 列表：`GET /resource/note/list?since_id=...`
- 详情：`GET /resource/note/detail?id=...`
- 鉴权：`Authorization: Bearer <API Key>`，`X-Client-ID: <Client ID>`

（若官方调整路径或字段，请以当前文档为准。）
