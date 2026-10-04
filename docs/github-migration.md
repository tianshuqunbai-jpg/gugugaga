# GitHub 迁移准备（2026-10-04）

目标：<https://github.com/tianshuqunbai-jpg/gugugaga>。

## 原始数据与历史

- 原项目作为保留副本，未编辑或清理。所有改动仅发生在独立上传准备目录。
- 原目录不是 Git 仓库，没有本地 Git 历史可带入。
- 目标仓库可见历史只有 1 个提交、2 个文件（README.md、LICENSE）；扫描所有可见 refs 的历史 blob，未发现密钥或私人数据路径。
- 保留目标仓库的 Apache-2.0 LICENSE 和原始提交；在 `prepare/github-migration` 本地分支准备文件，不需要重写历史或强制推送。

## API Key 检查与处理

- 原源码的密钥格式命中位于连接页输入框的示例占位符，内容由单一重复字符组成；未发现真实密钥。旧 Web/Android 构建文件也含这一示例，构建文件全部排除。
- `DEEPSEEK_API_KEY` 由 Node 端代理读取，前端请求使用 `/api/deepseek`，不发送浏览器 Authorization。
- `.env.example` 只包含空密钥字段；真实 `.env`、`.env.*`、签名密钥与凭证文件被 Git 排除。
- 浏览器只保存模型、思考方式、连接状态；忽略旧浏览器配置和旧备份中的 API Key。备份始终不导出密钥。
- 代理只允许本机访问与同源请求，只转发两个固定 API 路径，不打印请求内容或上游错误详情。
- 测试使用合成凭证与模拟服务，不读取真实密钥，也不向 DeepSeek 发出付费请求。

## 私人聊天记录

- 应用聊天、草稿、图片、角色设定、情绪与长期记忆保存在浏览器 localStorage/sessionStorage，启用隐私锁后部分数据为加密形式。
- 没有访问、导出或清除你的浏览器数据；改变启动地址会看到另一份浏览器存储，迁移本地使用时请保持原地址或自行使用应用备份恢复。
- 工作目录未发现独立的聊天 JSON、数据库或私人存档文件；预览截图可能含聊天与记忆，不进入上传副本。
- 旧代码 backup、预览、临时头像/精灵图、日志、node_modules、dist、Android 构建/缓存/已复制 Web 资源均不上传。
- `.gitignore` 还排除 data、exports、聊天/记忆备份命名、数据库与日志等，避免后续误提交。
- 项目测试里的聊天与记忆均为合成样例，保留以验证兼容性。

## 资源和运行限制

大模型与 WASM 在本机保留但不进入仓库，通过 `npm run setup:models` 准备；下载版本固定并校验摘要。Android 的本机 JDK 路径与图标脚本的绝对路径已改为可移植配置。

这次采用本机 Node 代理。Web 本机开发、预览和 `npm start` 支持代理；纯静态 GitHub Pages 和独立 APK 不具备此服务。公开部署或 APK 聊天需另行配置有认证和费用控制的后端。

## 本次验证结果

- 原项目 805 个文件的 SHA-256 在准备前后逐一比对，无改动或丢失。
- 38 项回归与隐私安全测试全部通过。
- 固定版本的模型已实际下载、校验，并通过应用嵌入流程生成 512 维单位向量。
- Web 生产构建通过；构建时注入合成环境变量值，输出文件中没有该值。
- 开发、预览、生产服务的本地代理检查通过；生产首页、禁止的敏感路径与缺少密钥时的响应符合预期。
- 上传工作区与目标仓库已有历史的扫描通过，未输出任何密钥值。
- ONNX 依赖仍有原有 eval/大包体构建提示；不影响本次构建成功。未测试真实 API、语音硬件或 Android APK。

## 上传前复核

```sh
npm ci
npm run setup:models
npm test
npm run build
npm run check:publish
git diff --cached --stat
```

`check:publish` 检查待上传工作区、暂存区和所有可见 Git 历史；发现疑似密钥只报告文件/行号，绝不打印值。它也检查私人数据路径、聊天 JSON 结构和大文件。启发式扫描不能识别任意自由文本里的隐私，新增文件仍应先人工检查。

本报告记录准备阶段的状态：当时只准备了本地分支与暂存文件，没有创建新的提交或向 GitHub 推送；后续上传由你另行授权。另提供从 Git 暂存区导出的源码 ZIP，不包含 .git、依赖、模型或构建产物。确认文件后可自行提交并推送准备分支，再通过 Pull Request 合入 main：

```sh
npm run check:publish
git commit -m "Prepare StarVox source for GitHub with server-side environment credentials"
git push -u origin prepare/github-migration
```

如果未来发现真实密钥进入过公共仓库，应先撤销/轮换该密钥，再决定如何清理受影响历史；本次检查未发现这种情况。
