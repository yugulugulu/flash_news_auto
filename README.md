# flash_news_auto v1.0

一个可复用的加密快讯抓取与 AI 改写项目，包含：
- 三家媒体快讯轮询抓取
- 通过规则筛选待推送快讯
- 基于 `chainthink_style.md` 的 AI 改写
- 本地 Dashboard 审阅与配置界面

> 本项目已尽量改为**相对路径**，方便别人直接拉下来复用。
> 本次整理仅处理：路径、文档、仓库发布准备；**不改核心业务逻辑**。

---

## 目录结构

```text
flash_news_auto/
├── flash_news_v2.mjs              # 主轮询脚本
├── ai_rewrite_pending.mjs         # 待改写快讯的 AI 改写脚本
├── pollerctl                      # 轮询控制脚本（启动/停止/状态/日志）
├── kuaixun_v2.json                # 抓取与筛选后的数据文件
├── chainthink_style.md            # AI 改写风格规范
├── model_config.example.json      # 模型配置示例
├── dashboard/                     # 前端 + 后端 Dashboard
│   ├── server.mjs                 # Dashboard API
│   ├── package.json
│   └── src/
└── README.md
```

---

## 运行环境

建议环境：
- Node.js 20+
- npm 10+
- Python 3（仅在导出 Word 报告时需要）

如果你要使用完整轮询能力，还需要项目原本依赖的本地工具/环境，例如：
- `bb-browser`
- 可用的 AI 模型调用方式（豆包或 Claude CLI）

> 注意：这类外部依赖属于运行环境，不属于本次“相对路径改造”范围。

---

## 安装依赖

### 1）Dashboard 依赖

```bash
cd dashboard
npm install
```

主轮询脚本没有单独的根 `package.json`，目前按现有结构直接使用 Node 运行。

---

## 配置说明

### 1）模型配置

先复制示例配置：

```bash
cp model_config.example.json model_config.json
```

然后编辑 `model_config.json`：

```json
{
  "provider": "doubao",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKey": "your-api-key",
  "model": "your-model-id",
  "enabled": true
}
```

字段说明：
- `provider`：当前主要使用 `doubao`
- `baseUrl`：模型接口基础地址
- `apiKey`：你的 API Key
- `model`：模型 ID
- `enabled`：是否启用

### 2）数据文件

默认数据文件：
- `kuaixun_v2.json`

如果首次运行不存在，脚本会自动创建。

---

## 如何启动

### 启动轮询

在项目根目录执行：

```bash
./pollerctl start
```

查看状态：

```bash
./pollerctl status
```

查看实时日志：

```bash
./pollerctl logs
```

前台手动跑一轮：

```bash
./pollerctl once
```

---

## 如何关闭

停止轮询：

```bash
./pollerctl stop
```

重启轮询：

```bash
./pollerctl restart
```

清理运行态文件（不删除核心代码）：

```bash
./pollerctl clean
```

重置运行数据（会清理 json/docx/temp 数据，请谨慎使用）：

```bash
./pollerctl reset
```

---

## 如何启动 Dashboard

### 启动 API

```bash
cd dashboard
npm run dev:api
```

这个命令现在会先自动执行一次：
- `../pollerctl start`

也就是说：**启动后端 API 时，会顺手拉起快讯轮询**，用户不需要再单独执行 `./pollerctl start`。

默认地址：
- `http://localhost:8787`

### 启动前端

新开一个终端：

```bash
cd dashboard
npm run dev -- --host 0.0.0.0
```

默认地址通常是：
- `http://localhost:5173`
- 如果 5173 被占用，Vite 会自动切到下一个端口，例如 `5174`

### 一键全开（推荐）

如果你希望前端、后端、轮询一起启动，直接执行：

```bash
cd dashboard
npm run dev:all
```

它会自动：
- 启动轮询
- 启动 Dashboard API
- 启动前端页面
- 在你按下 `Ctrl + C` 时，一并把前端、API、轮询都停干净

---

## 如何关闭 Dashboard

如果你是前台启动：
- 直接在终端按 `Ctrl + C`

如果你是后台启动（例如 `nohup`）：
- 用 `ps` / `lsof` 找到进程后结束

示例：

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -nP -iTCP:5173 -sTCP:LISTEN
lsof -nP -iTCP:5174 -sTCP:LISTEN
```

---

## Dashboard 可做什么

当前整理后的 Dashboard 主要支持：
- 查看三家媒体的待推送快讯
- 按媒体筛选
- 最近消息优先
- 分页（每页 5 条）
- 只显示 AI 已优化的快讯
- 查看 / 编辑豆包配置
- 测试模型连接
- 复制 API Key

---

## 完整性检查建议

发布或迁移前，建议至少执行一次：

### 1）检查主脚本语法

```bash
node --check flash_news_v2.mjs
node --check ai_rewrite_pending.mjs
```

### 2）检查 Dashboard 构建

```bash
cd dashboard
npm run build
```

### 3）检查轮询状态

```bash
./pollerctl status
```

---

## 注意事项

1. 本项目现在已把关键硬编码项目路径改为**相对路径/脚本目录推导**。
2. 但如果你的环境依赖外部工具（例如 `bb-browser`、Claude CLI），仍需你自己安装。
3. `model_config.json` 可能包含敏感信息，**不要提交到公共仓库**。
4. 仓库建议提交：
   - 源码
   - `model_config.example.json`
   - README
   - 不要提交本地日志、PID、运行态文件、真实 API Key

---

## 推荐发布流程

```bash
git init
git add .
git commit -m "release: v1.0"
git tag v1.0
```

然后绑定远程仓库并推送：

```bash
git remote add origin <your-repo-url>
git push -u origin main
git push origin v1.0
```

---

## License

如果你准备公开发布，建议补一个 LICENSE 文件（如 MIT）。
目前本项目未自动添加许可证，请按你的发布需求自行决定。
