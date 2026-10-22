# @zzhaobh/dsh-server-error-continue

[English](README.md) | 中文

[![CI](https://github.com/zzhaobh/dsh-server-error-continue/actions/workflows/ci.yml/badge.svg)](https://github.com/zzhaobh/dsh-server-error-continue/actions/workflows/ci.yml)

DeepSeek Harness（DSH）插件包：模型请求因服务端或上游临时错误失败时，按四层顺序恢复——**同请求重试** → **内置重试耗尽后的升级** → **有界回合重启** → **可选应急路由切换（如 deepseek-account/deepseek-flash）**。既不会无限重发同一个请求，也不会把认证、额度、上下文超限、模型不存在这类永久错误当成瞬态错误反复重试；对网关侧“加密 reasoning 无法跨账号解密”“上游流中途断开（TransferEncodingError / ConnectionResetError）”“Connection error.”这类伪 400 也会做有界重试；即使 provider 没有配置 retryPolicy，`SERVER`/`TIMEOUT`/`TRANSPORT`/`RATE_LIMIT`/`EMPTY_RESPONSE` 也仍可恢复。支持用户停止、卸载取消、指数退避、服务端 `Retry-After`，以及重启提示的撤回与预算复位。

## 要求

- DSH `>=0.2.1-rc.2 <0.3.0`（通过 `engines.dsh` 声明；超出范围的安装会跳过该 bundle 并给出警告，除非显式授予精确版本豁免）。
- Node.js 20 或更新版本。
- 这是 Host-only 插件：只贡献 Cordis loader 行，没有客户端 UI。

## 安装

安装或升级到 `main` 最新 commit，只需一行：

```sh
dsh plugin --profile <profile> add "github:zzhaobh/dsh-server-error-continue#main"
```

再次执行同一命令即可升级：pnpm 会重新解析分支引用，lock 跟到 `main` 最新 commit。包是纯 JavaScript，没有构建步骤，也不需要 `prepare` 脚本或 pnpm 构建脚本授权。

需要可复现时改为固定 commit：

```sh
dsh plugin --profile <profile> add "github:zzhaobh/dsh-server-error-continue#<commit>"
```

本地开发时也可以直接链接 checkout：

```sh
dsh plugin --profile <profile> add /path/to/dsh-server-error-continue
```

启动前验证层，再启动：

```sh
dsh --profile <profile> --dump-config | grep -A6 server-error-continue
dsh --profile <profile>
```

由 Electron 托管的 `desktop` profile 拒绝 CLI 的 boot/config-dump，请通过应用内插件管理器或直接编辑 profile 文件管理。

移除：`dsh plugin --profile <profile> remove @zzhaobh/dsh-server-error-continue` 会同时移除依赖和 bundle 层。

## 配置

默认值在 bundle 自带的 [`cordis.patch.yml`](cordis.patch.yml) 中。用户可在 profile 自己的 `cordis.patch.yml` 覆盖该行；patch 会替换整个 `config` 值（不深合并），因此需要重述所有要保留的键。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `delayMs` | `1000` | 同请求首次重试等待，之后按 2 倍增长 |
| `maxDelayMs` | `30000` | 退避上限，必须不小于 `delayMs` |
| `maxContinues` | `3` | **每个失败 step** 的额外同请求次数；`0` 表示无限（显式 opt-in），此时回合重启阶段不可达 |
| `maxRestarts` | `2` | **每个失败链**的额外回合重启次数；`0` 关闭回合重启，退回同请求重试 |
| `codes` | `["SERVER"]` | 额外可恢复错误码；终止码与永久文本排除仍然优先 |
| `messageIncludes` | `["server_error", "upstream_error", "overloaded"]` | 包装码的额外大小写不敏感瞬态子串 |
| `excludeIncludes` | `[]` | 站点特有永久子串；命中即否决文本兜底与内置 replay override |
| `retryUnclassified` | `true` | 包装码未命中任何永久/瞬态文本时是否按瞬态处理；`false` 恢复严格白名单模式 |
| `fallbackProvider` | 未设置 | 应急 provider 路由，仅在重试和回合重启都耗尽后使用；必须与 `fallbackModel` 同时设置 |
| `fallbackModel` | 未设置 | 应急模型，例如 `deepseek-flash` |
| `prompt` | `continue` | 兼容 v1 的旧配置，已弃用且不会发送；显式配置会记录警告 |

profile 覆盖示例：

```yaml
- id: server-error-continue
  name: '@zzhaobh/dsh-server-error-continue'
  config:
    delayMs: 2000
    maxDelayMs: 30000
    maxContinues: 3
    maxRestarts: 3
    codes:
      - SERVER
    messageIncludes:
      - server_error
      - upstream_error
      - overloaded
    excludeIncludes: []
    retryUnclassified: true
    fallbackProvider: deepseek-account
    fallbackModel: deepseek-flash
```

## 错误分类与恢复顺序

1. **永久事实先排除**（优先于错误码、HTTP 状态和任何重试规则）：终止错误码、认证/权限、额度/计费/余额、上下文超限/413、非法 schema/请求/参数/API key、模型不存在/不支持/无可用通道、内容策略/安全过滤、适配器 `deferred response`/`ended pending`、`excludeIncludes`，以及非瞬态 4xx。408/425/429 例外。
2. 命中 `codes`（默认 `SERVER`）或 HTTP 5xx → 可恢复。
3. `PI_AI_ERROR`/`UNKNOWN` 包装码：先匹配 `messageIncludes` 与内置瞬态文本（英文 + 中文），都未命中时按 `retryUnclassified`（默认 `true`）视为瞬态。
4. **网关伪 400 override**：加密 reasoning 无法验证/解密、`previous_response_id ... not found`、`上游流中途断开` / `TransferEncodingError` / `ConnectionResetError` / `Connection error.` / incomplete payload/chunked read 等传输中断文本先按瞬态处理（`excludeIncludes` 可否决），优先于 400/`INVALID_REQUEST` 的终止判断。`Response incomplete: content_filter` 等内容过滤截断仍保持终止。
   此外，即使 provider 没有配置 retryPolicy，`SERVER`/`TIMEOUT`/`TRANSPORT`/`RATE_LIMIT`/`EMPTY_RESPONSE` 也直接视为可恢复码。
5. 同请求重试在 `agent/request-error` waterfall 中后置，其他恢复器（包括 DSH 内置 provider retry）优先。
6. provider `normal` 策略已管理并耗尽某码时，不再叠加同样的请求，直接进入回合重启阶段；provider `always` 策略保持独占，本插件不介入。
7. 回合重启**不在失败回合内排队**：错误路径会让 driver 直接退出，回合内 followup 不会唤醒 agent。插件先记录 restart intent，等 agent 进入 idle 后再用 `agent.followup()` 排队 `source.kind: server-error-continue`（不是 `user`）的显式重启提示，从而真正唤醒新 turn、发新请求。
8. **应急模型切换**：如果重启预算也耗尽，下一请求通过 `agent/request` waterfall 改写到 `fallbackProvider`/`fallbackModel`。请求头持久记录应急路由，后续请求无需每次强制改写；用户显式选择模型（`model/selection`）会立即结束应急状态。永久错误不会触发切换；两个字段都未配置时该功能关闭。
9. **路由 replay 不兼容**：provider 拒收自己回放的历史 item ID（如 `Invalid 'input[85].id': 'item_...'. Expected an ID that begins with 'msg'`）时，同一条历史在同一路由上重试不可能成功，因此跳过重试/重启预算，立即切到应急路由并重试一次。

## 重启链的生命周期

- 计数绑定 Agent 上的失败链：成功回合（`turn/end` 原因不是 `error`）、真实用户输入、插件卸载都会结束链并归零。
- 真实用户消息或其他自动生产者（goal round、schedule、job 唤醒等）插入 inbox 时，排队中的重启提示会被撤回并让位。
- 用户停止会清空 inbox；取消信号置位后不再排队重启。
- 已有 pending 用户消息或 goal round 时让位；待处理的自动通知（subagent 结果、schedule 提醒等）不再阻止重启，会与新回合一起被消费。
- 应急路由独立于重启链：成功回合不会清除它，只有用户显式选择模型、Agent 销毁或插件卸载才会退出；切换后会话中会追加一条 `model-selection` 通知，说明原路由与应急路由。
- 卸载/重载会撤回未 claim 的重启提示并等待在途恢复结束；`agent/pre-step` 校验预约，失效则 reject。
- 排队后被撤回或 discarded 的重启退还预算槽位；已 claim 后因校验失败被拒的不退。

## 验证与边界

- 单测：`node --test test/plugin.test.mjs`；当前 60 PASS，完整记录与证据边界见 [VERIFICATION.md](VERIFICATION.md)。
- CI 在 Node 20/22/24 上运行 `node --check` 与完整测试。
- 只处理“流内 finish error”；流开始前抛出的异常，以及不经过 agent loop 的直连 LLM 调用（会话标题、压缩摘要等）不在覆盖范围内。
- “未分类即瞬态”是有界但偏乐观的策略：未知永久错误可能先消耗 `maxContinues` 次重试和最多 `maxRestarts` 次重启才终止；可用 `retryUnclassified: false` 或 `excludeIncludes` 收紧。
- 重启提示会作为会话消息进入历史（与 goal round 机制相同），但不冒充用户发言。
- 恢复预算只存在于当前进程与失败链上，不跨插件重载或 DSH 重启持久化。
- 应急切换只改路由，不能让失效凭证变有效：`deepseek-account` 必须已登录（或换用其他已配置 provider）；跨 provider 切换会把 provider 私有 replay 状态降级为通用历史。
- item ID 拒收属于 provider/adapter 的回放兼容问题，不是本插件能修复的存储历史；应急切换只是绕过该路由，应急路由必须能接受这条外来历史才有效。
- 不对所有 provider/网关错误类声明真实端到端验证；详见 [VERIFICATION.md](VERIFICATION.md)。

## 开发

```sh
node --check index.js
node --test test/plugin.test.mjs
```

无运行时依赖。插件入口导出 `apply(ctx, config)`，bundle loader 行在 `cordis.patch.yml` 中声明。

## 许可证

[MIT](LICENSE) © zzhaobh
