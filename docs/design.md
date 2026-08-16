# DSH 自主性插件（dsh-autonomy）设计文档

日期：2026-08-16
状态：已确认（用户：每会话独立；天马行空档"先说明再动手"）

## 1. 背景与目标

DSH 的模型在单轮对话中自主性极强（多工具调用、长链路执行）。用户需要一个轻量控件，
按会话调节模型的自主性/创造力，在"只需一个小改动"和"放手去干"之间切换。

- 输入框工具行、模型切换器左侧新增一个自主性切换器；
- 点击弹出滑块，五档：严格遵循 → 听取要求 → 正常发挥 → 展现创造 → 天马行空；
- 每会话独立记忆，重启不丢；
- 全局默认档 + 会话覆盖档；
- UI 使用 DSH 原语与设计 token。

## 2. 机制选型

| 方案 | 结论 |
|---|---|
| 采样参数（temperature/effort） | ✗ 自主性本质是行为指令（是否主动多做、多用工具），不是采样随机性；且 DSH 模型选择暴露的是 effort 而非 temperature，跨 provider 不可移植 |
| 每档一个 agent preset | ✗ 切 preset 会连带改模型/工具集，太重，不是"小功能" |
| **systemPrompt.section 动态段（采用）** | ✓ DSH 官方机制：`text` provider 每次组装模型请求时重新求值（omd 已验证"settings edits show up immediately"）；host 平面注册 = 全局段，对所有会话/所有 preset 生效 |

核心机制：**提示词注入要走官方注册表（`systemPrompt.section`），不是字符串拼接**。
"正常发挥"档返回空文本，渲染时自动丢弃 = 零干预，关闭功能时对提示词零污染。

## 3. 架构

两个包（参照 omd 工程骨架），**不需要 agent preset**：

```
dsh-autonomy（host 包）
├── settings       namespace 'autonomy'：{ level: strict|heed|normal|creative|wild }，默认 normal，applies: 'live'
├── 提示词段       systemPrompt.section('autonomy:level', order 50)：text provider 读「会话覆盖 ?? 全局默认」
├── 命令           /autonomy [strict|heed|normal|creative|wild|reset|status]
│                   ├── host 全局注册（聊天输入 / CLI 兜底）
│                   └── agent 平面注册（agent/created 时动态挂载进该 agent 作用域；
│                       客户端 remote.commands.execute 分发到 agent 命令注册表，host 注册不可达 —— omd 验证）
└── 投影           sessionProjections key 'autonomy'：{ level: Level|null }，把会话覆盖镜像给 web 客户端

dsh-autonomy-client（web 包）
└── 滑块           conversation.input.right 槽（order 1000 → 渲染在模型切换器紧左侧）
                   触发 Button + 自绘 5 刻度滑块卡片（--dsw-* token）
                   写路径：remote.commands.execute(sessionId, '/autonomy <level>')
```

### 3.1 状态模型（每会话独立、重启不丢）

- 全局默认：settings 文档（持久化）。
- 会话覆盖：`session.append('autonomy/level', { level })` 写会话事件日志 —— 随会话持久化，
  跨重启重放（omd 的 `omd/mode` 同款机制，"The fold replays across restart/resume"）。
- 覆盖语义：最后一条 `autonomy/level` 事件赢；`{ level: null }` 表示重置为默认。
- 有效档位 = `overrideLevel(session.events) ?? settings.default`，在提示词段 provider 内同步求值，
  无需任何订阅 —— **改档后下一条消息即生效，无需重启、无需新会话**。
- 客户端投影：`useProjection('autonomy')` 推送会话覆盖（null = 无覆盖），UI 显示真实有效档位。

### 3.2 写路径（客户端 → host）

客户端唯一可用的会话级写入通道是 `remote.commands.execute(sessionId, line)`，它分发到**会话的
agent 命令注册表**。omd 的实测经验：host 平面注册的命令从这个通道不可达，必须注册在 agent 平面
（他们靠 preset 里的 dsh-omd-agent 副本）。

本插件无 preset，故在 host 监听 `agent/created`（payload 自带 agent 对象，发生在 preset 配置
完成之后、首次组装之前），把极小的命令插件动态挂载进该 agent 的作用域（`agent.ctx.plugin(...)`，
与 cordis 运行时动态插件同一契约；agent ctx 销毁时 fiber 自动卸载）。`agent/created` 对每个
agent（含 resume 重建）都触发一次，每次挂载进新 ctx，不会重复注册。

兜底：若部署实测发现 host 全局命令经该通道可达（静态分析显示 CommandRuntime 全局层应当可见，
与 omd 经验矛盾），agent 平面副本 shadow 全局同名命令，两种情况下客户端行为一致，无需改动。

次选兜底（文档记录，不实现）：settings 里放 `{ perSession: { [sessionId]: level } }` 映射 ——
omd 的 settings 写通道端到端验证过，最坏情况 100% 可用。

## 4. 五档提示词

"正常发挥"档返回空字符串（零注入）。其余档位为英文行为指令（对模型效力更强），UI 显示中文。

| 档位 | id | 要点 |
|---|---|---|
| 严格遵循 | strict | 只做字面请求；不加步骤/工具/文件/交付物；不做请求外的探索与重构；歧义即停问；工具调用最小化 |
| 听取要求 | heed | 忠实执行请求范围；仅允许必要支撑步骤（编辑前读文件、行动前查状态）；不做请求外的重构/加功能/研究 |
| 正常发挥 | normal | 空文本，出厂行为 |
| 展现创造 | creative | 在请求范围内主动：指出改进点/替代方案/风险；明显有价值时可做适度额外工作（相邻清理、测试、快速研究）并说明；多给带权衡的选项 |
| 天马行空 | wild | 追求意图而非字面；**动手前先用一句话说明意图再添加**（用户确认）；主动添加用户未提及、但提升体验且符合其需求的功能；禁止与显式约束冲突；幅度与任务相称；自由探索多路线、可委派可实验；完成后列出新增项与理由 |

用户确认的交互约定：天马行空档新增功能采用"**先说明再动手**"。

## 5. UI 设计

- 位置：`conversation.input.right`（list/session）取 order 1000 → 渲染在 `[rightItems] [model座]`
  之间，即**模型切换器紧左侧**（已核实 InputBar 布局：`trailing = [rightItems, model座, contextMeter, stop, send]`）。
- 触发：primitives `Button`（variant toolbar / size sm），文案「自主性 · 当前档位中文名」+ chevron 图标，
  与左侧权限选择器同风格；失败时显示 ⚠ 并在 title 里给出错误（omd 同款）。
- 弹出卡片：Menu 风格（`--dsw-specific-menu` 背景、`--dsw-alias-border-l2` 描边、`--dsw-alias-label-*` 文字），
  内含：
  - 标题「自主性」；
  - 自绘 5 刻度滑块轨道（primitives 无 Slider 原语，为唯一自绘点）：横线 + 5 个可点击刻度点，
    选中点用 `--dsw-alias-brand-primary` 填充，刻度下方档位名；点击即选；
  - 当前档位一行描述（`--dsw-alias-label-tertiary`）；
  - 会话覆盖存在时显示「重置为默认」按钮（执行 `/autonomy reset`）。
- 交互：选择成功即关闭；写失败不静默（⚠ + tooltip）。

## 6. 部署（deploy.ps1）

1. 构建两包（client 包经 build-client.mjs 打 `window.__ModuleLoader__` 手接格式）；
2. `npm install <本地路径>` 装入 profile（junction，改代码重建即生效）；
3. profile `cordis.patch.yml` 用 `- insert:` 追加 `autonomy`（host）+ `autonomy-client`（web）两行；
4. 白名单 patch：`WEB_SETTINGS_NAMESPACES` 追加 `"autonomy"`（dsh-host-apiproxy/lib/index.js，
   幂等，升级 DSH 后重跑）；
5. 重启 host 端到端验证（重启会中断会话，由用户执行）。

## 7. 测试计划

- `test-apply.mjs`（host，mock ctx）：
  - settings.register('autonomy', applies 'live')；
  - 全局 + agent 平面两条 /autonomy 命令注册；
  - agent/created 监听器挂载 agent 命令；
  - 提示词段：五档文本正确、normal 为空、会话覆盖优先于默认、无关会话不受影响；
  - /autonomy 命令：合法值写事件、非法值报错、reset 写 null、status 报告有效档；
  - 投影：init null、apply 折叠覆盖与重置、无关事件返回同引用。
- `test-client-apply.mjs`（client，mock ctx）：slots 注册到 conversation.input.right、settingsScope.bind。

## 8. 已知风险

- 动态挂载 `agent.ctx.plugin` 是运行时组合，属新用法：agent/created 时序与 fiber 生命周期在冒烟测试
  中验证注册，端到端由部署后实测确认；
- 客户端命令可达性按 omd 经验（不可达）设计，留有文档化兜底；
- 白名单 patch 改 node_modules，升级 DSH 后需重跑 deploy；
- host 插件改动需重启 DSH（hmr disabled）。

## 9. 未来扩展（不实现）

- 严格档工具门控（tools 注册表作用域 shadow，隐藏 subagent/workflow）；
- 天马行空档附加采样参数增强（如 temperature），需 provider 支持；
- 每会话"跟随默认"与"固定档位"两种覆盖语义的 UI 区分。
