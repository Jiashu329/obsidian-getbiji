# GetBiji（Obsidian 插件）

这是一款 [Obsidian](https://obsidian.md/) 插件，用于将 [Get 笔记](https://www.biji.com) 云端内容，通过[开放平台 API](https://www.biji.com/openapi) **同步到当前 Obsidian 库**，生成标准 Markdown 笔记（含 YAML 文档属性、正文与链接汇总等）。

**源码仓库**：[https://github.com/Jiashu329/obsidian-getbiji](https://github.com/Jiashu329/obsidian-getbiji)

---

若在使用中有疑问、希望增加能力或发现异常，欢迎提 [Issues](https://github.com/Jiashu329/obsidian-getbiji/issues)。  
如果觉得有帮助，欢迎点亮 **Star**。

## 功能

- ☑️ 使用 Client ID、API Key 连接开放平台，分页拉取同步列表；可选**全量覆盖**或**按 get_note_id 跳过已有笔记**  
- ☑️ **同步目录**可手填或从本库已有文件夹联想；目录不存在时会自动创建  
- ☑️ 笔记以**标题**为文件名（重名自动加 `_2`、`_3`…）；YAML 保留 `get_note_id` 等元数据  
- ☑️ 首条 `type: link` 的附件可写入顶层 `**Link`** 属性；更多外链在正文 **「关联链接」** 中展示  
- ☑️ 正文中指向 Get 站内笔记的链接，在条件允许时改写为 Obsidian **双链** `[[同步目录/标题]]`  
- ☑️ 支持同步过程中**取消**（取消后不会更新列表游标）  
- ☑️ 支持桌面端与移动端（见 `manifest.json` 中的最低 Obsidian 版本要求）

## 效果

同步完成后，在设定的同步目录下会出现以标题命名的 `.md` 文件：可在编辑模式下查看 **YAML 属性**，在阅读模式下查看 **「关联链接」**、正文与可选的网页摘录、音频块等。  
（如需配图展示，可自行在仓库中增加 `doc/` 截图后补充到本 README。）

## 如何使用

### 配置凭证

1. 打开 **设置 → GetBiji**（插件名称以界面为准）。
2. 在 **「同步信息」** 中填写 **Client ID**、**API Key**（在 [Get 笔记开放平台](https://www.biji.com/openapi) 的应用管理、API Key 页面创建并获取）。
3. 设置 **同步目录**（相对于当前库的路径；可输入关键词从已有文件夹列表中选择）。

### 执行同步

1. 按 `Ctrl/Cmd + P` 打开命令面板，搜索 **「同步 Get 笔记」** 并执行；或点击左侧功能区 **云下载** 图标。
2. 等待弹窗完成「拉取列表 → 逐条写入」；可随时 **取消同步**。

### 同步方式说明

在 **设置 → GetBiji → 同步方式** 中选择：

- **全量更新（覆盖）**：每次从云端从头拉列表，对每条笔记拉取详情并**始终覆盖写入**（与本地是否已有同 `get_note_id` 无关）。
- **增量更新（跳过已有 ID）**：同样从头拉完整列表，但若同步目录下已有 Markdown 的 YAML 中含**相同 `get_note_id`**，则**跳过该条**（不拉详情、不改文件）。识别依赖 Obsidian 对 frontmatter 的元数据索引。

列表请求始终从接口的 `since_id=0` 开始分页，**不再在本地持久化列表游标**。

## 设置


| 设置项   | 说明                                  |
| ----- | ----------------------------------- |
| Client ID | 开放平台应用标识，请求头 `X-Client-ID`          |
| API Key   | 开放平台密钥，默认 `Authorization: Bearer …` |
| 同步目录  | 笔记写入的相对路径，默认可为 `GetBiji`            |
| 同步方式  | 全量覆盖写入，或按 `get_note_id` 跳过已有笔记（增量）   |

> 更多高级参数（如请求间隔、鉴权方式等）若在当前版本中未在界面展示，可能仍保存在插件数据文件中并以默认值参与逻辑；以实际发布版本为准。

## 同步内容与 YAML 字段

下列为常见写入 **文档属性（frontmatter）** 的字段（以接口实际返回为准；若某条笔记详情不可用，内容可能退化为列表接口字段，附件等可能不完整）。


| 字段                          | 说明                                                              |
| --------------------------- | --------------------------------------------------------------- |
| `get_note_id`               | Get 笔记 ID                                                       |
| `title`                     | 标题                                                              |
| `note_type`                 | 笔记类型                                                            |
| `source`                    | 来源                                                              |
| `updated_at` / `created_at` | 更新时间 / 创建时间                                                     |
| `tags`                      | 标签列表                                                            |
| `Link`                      | 首条 `type: link` 附件时，值为 `"[标题](url)"` 形式                         |
| `get_note_attachments`      | **仅非 link 类型**附件的结构化列表（含 `type`、`url`、`title` 等）；纯链接类附件不再重复写入此块 |


正文内可能包含：**笔记正文 / 引用**、**关联链接**（汇总外链）、**链接**（网页类）、**音频** 等区块，具体取决于云端数据。

## 如何安装

### 从 Obsidian 社区插件安装（上架通过后）

1. 打开 Obsidian **设置 → 第三方插件**，关闭安全模式（若从未开启过第三方插件，按提示操作）。
2. 进入 **浏览**，搜索 **GetBiji**（或插件 ID `getbiji`）。
3. **安装** 并 **启用**。

### 手动安装

1. 打开 [GitHub Releases](https://github.com/Jiashu329/obsidian-getbiji/releases)，下载对应版本的 `**main.js`**、`**manifest.json**`，若 Release 中包含则一并下载 `**styles.css**`。
2. 在你的 Obsidian **库根目录**下创建路径：`.obsidian/plugins/getbiji/`（若 `.obsidian` 为隐藏文件夹，请在系统中显示隐藏项）。
3. 将上述文件放入 `getbiji` 文件夹（文件夹名须与 `manifest.json` 中的 `id` 一致）。
4. 回到 Obsidian：**设置 → 第三方插件** 中启用 **GetBiji**。

## 如何开发调试

1. 进入测试库目录下的 `.obsidian/plugins/`。
2. 克隆仓库：
  `git clone https://github.com/Jiashu329/obsidian-getbiji.git`
3. 进入目录：`cd obsidian-getbiji`
4. 安装依赖：`npm install`
5. 构建：`npm run build`（监听构建可使用 `npm run dev`）
6. 在 Obsidian 中 **重新加载应用** 或重载插件。
7. 修改源码后重复构建即可调试。

## 安全与隐私

- API Key 等凭证仅保存在本机 Obsidian 插件数据目录，**不会**上传到插件作者服务器。  
- 请勿将包含密钥的配置或数据文件提交到公开仓库。

## 免责声明

1. 使用前请至少保留一种**备份方式**（如 Obsidian 官方同步、Git、网盘等），避免数据丢失。
2. 本插件依赖 Get 笔记开放平台；**接口变更、限流、鉴权策略**等可能导致同步失败或内容不完整，请以官方文档为准。
3. 本程序仅供学习与交流；因使用本插件造成的直接或间接损失，由使用者自行承担；请在理解同步逻辑与「影响」表格后再使用。
4. 使用或修改本插件，即视为同意上述说明。

## 影响（同步会改什么）


| 操作   | 条件                  | 影响                                |
| ---- | ------------------- | --------------------------------- |
| 同步笔记 | 目标路径尚无文件            | 在「同步目录」下**新建**对应标题的 `.md`         |
| 同步笔记 | 目标路径**已存在同名** `.md` | **整文件覆盖**为本次云端内容（以云端为准）           |
| 取消同步 | 中途取消                | 已写入的笔记保留；**不会**更新列表游标（`since_id`） |
| 详情失败 | 接口报错等               | 可能使用列表字段生成略简内容；附件、正文可能少于完整详情      |


## 许可证

本项目以 **GNU General Public License v3.0（GPL-3.0）** 发布，见仓库根目录 `[LICENSE](./LICENSE)`。

## 相关链接

- Get 笔记开放平台：[https://www.biji.com/openapi](https://www.biji.com/openapi)  
- Obsidian 插件发布说明：[https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)

