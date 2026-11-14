# @zzhaobh/dsh-server-error-continue

[English](README.md) | 中文

DSH 3.0.0 低侵入模型请求重试插件：只通过公开的 `agent/request-error` waterfall，在模型请求已经失败后，对可恢复的连接、限流和服务端错误执行有界重试。

## 稳定性原则

- **只注册一个 Host 钩子**：`agent/request-error`。
- 不注入 system prompt、续写提示、用户消息或 assistant 消息。
- 不读写会话历史，不操作 inbox，不调用 `followup()`，不接管 Agent 生命周期。
- 不修改 provider/model，不做应急路由或模型切换。
- DSH 原生重试器优先；本插件只处理其未接管的可恢复错误。
- 无运行时依赖，无需构建步骤。正常请求和成功回合完全不经过本插件。

## 要求与安装

- DSH `>=0.2.1-rc.2 <0.3.0`。
- Node.js 20.3.0 或更新版本（`AbortSignal.any()` 的最低版本）。
- Host-only 插件，没有客户端 UI。

```sh
dsh plugin --profile <profile> add "github:zzhaobh/dsh-server-error-continue#<commit>"
```

本地开发可链接 checkout：

```sh
dsh plugin --profile <profile> add /path/to/dsh-server-error-continue
```

安装、升级或移除后重启 Host，确认运行中的实例已加载目标版本。

## 从 2.x 迁移

3.0.0 删除以下高侵入能力：

- 回合重启及自动 `continue` 提示；
- inbox/session/status/pre-step 监听；
- `fallbackProvider` / `fallbackModel` 应急切换；
- provider replay item-ID 不兼容时的自动换路由。

`prompt`、`maxRestarts`、`fallbackProvider`、`fallbackModel` 仍可出现在旧配置中，但只会产生 `ignored legacy keys` 警告，不会执行任何行为。请从 profile 中移除它们。

原生 provider `normal` 策略管理并耗尽的代码不再叠加第二份重试预算，也不会升级为回合重启。需要改变原生预算时，应调整该 provider 自己的 `retryPolicy`。

## 配置

bundle 默认配置位于 [`cordis.patch.yml`](cordis.patch.yml)。覆盖 patch 中的 `config` 时会替换整个对象，需要重述所有要保留的键。

| 字段 | bundle 默认 | 含义 |
|---|---:|---|
| `delayMs` | `1000` | 第一次额外重试的等待，之后按 2 倍增长；必须 ≥1 |
| `maxDelayMs` | `30000` | 退避与可接受的 `Retry-After` 上限，必须 ≥`delayMs` |
| `maxContinues` | `5` | 每个失败 step 的额外请求次数；代码内默认值是 `3`，bundle 显式设为 `5` |
| `codes` | `["SERVER"]` | 额外允许恢复的错误码，永久错误排除仍优先 |
| `messageIncludes` | `["server_error", "upstream_error", "overloaded"]` | 包装码的额外瞬态文本，大小写不敏感 |
| `excludeIncludes` | `[]` | 永久文本排除，优先于瞬态覆盖规则 |
| `retryUnclassified` | `true` | 未识别的 `PI_AI_ERROR`/`UNKNOWN` 包装错误是否按瞬态处理；`false` 使用严格白名单 |

`maxContinues: 0` 是显式无限重试选项，仅在用户停止、Agent 替换或插件卸载时结束。默认保持有限，不建议无人值守任务使用无限模式。

## 恢复顺序

1. **内容过滤直接终止**：不调用下游恢复器，因此原生 `always` 也不会绕过内容策略。
2. 调用 `next()`，保留原生或其他恢复器的决定；下游异常原样传播。
3. provider `always` 策略保持独占，本插件不介入。
4. provider `normal` 策略管理的代码以其预算为准，本插件不补加次数。
5. 永久事实优先：认证/权限、额度/计费、上下文超限、非法 schema/请求/参数、模型不存在或不支持、内容策略、非瞬态 4xx 不重试。
6. 对未被原生策略接管的可恢复错误，执行同 step、同历史、同 provider/model 的重试。
7. 等待期间响应用户取消和插件卸载；等待后确认原 Agent 仍注册，再返回 `{ kind: "retry" }`。

插件只返回 DSH 原生恢复动作。真正的重新执行由 agent loop 完成，插件不会自行发起网络请求。

## 覆盖的瞬态错误

- 标准码：`SERVER`、`TIMEOUT`、`TRANSPORT`、`RATE_LIMIT`、`EMPTY_RESPONSE`。
- HTTP 408、425、429 和 5xx。
- `PI_AI_ERROR` / `UNKNOWN` 等包装码中的服务端、限流和断连文本。
- 连接重置/拒绝/关闭、socket hang up、EOF、超时、broken pipe、网络不可达。
- 上游流中途断开、`TransferEncodingError`、`ConnectionResetError`、incomplete chunked read、缺少 terminal response event。
- 网关将加密 reasoning 验证/解密、`previous_response_id` 等临时路由亲和问题包装成 400 的已知情况。

`retryUnclassified: false` 可关闭未知包装文本的乐观兜底。`excludeIncludes` 可否决任何文本兜底和瞬态覆盖。

本插件不会为以下错误追加重试：认证、权限、额度、余额、上下文超限、非法请求/工具参数、模型不存在/不支持、内容过滤，以及普通 4xx；即使文本同时含有连接断开或加密 reasoning 覆盖词，明确终止码和永久事实仍优先。显式原生 `always`/`normal` 策略仍按各自配置拥有恢复权，内容过滤例外，始终被本插件 veto。provider 自己拒收历史 item-ID schema 时，本版本也不会换模型绕过。

## 退避与取消

- 退避从 `delayMs` 开始，每次翻倍，最高 `maxDelayMs`。
- 合法 `Retry-After` 不会被本地退避缩短；超过 `maxDelayMs` 时保持失败，不进行超长等待。
- 用户停止会传播原始 `AbortError`；插件卸载会中止并等待所有在途恢复结束。
- 重试预算只存在当前进程内，按 Agent + turn + step + signal 隔离，不持久化、不读取 session。

## 验证与边界

```sh
npm test
npm pack --dry-run
```

真实 Cordis 挂载验证脚本为 `test/cordis-mount.mjs`。在本机 DSH 安装上通过 Electron 运行，不发出模型请求：

```sh
ELECTRON_RUN_AS_NODE=1 \
DSH_CORDIS_ENTRY="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js" \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" test/cordis-mount.mjs
```

当前证据和精确结果见 [VERIFICATION.md](VERIFICATION.md)。

边界：

- 仅覆盖 agent loop 的流内模型请求失败；`ctx.llm.stream()` 直连、标题/摘要等独立调用不在范围内。
- 不保证每个 provider 的真实故障都能恢复，也不保证服务会在有限预算内恢复。
- 单元和 Cordis 测试证明分类、动作、取消和 API 表面，不替代各 provider 的真实断网端到端演练。

## 开发

```sh
node --check index.js
node --test --test-timeout=10000 test/plugin.test.mjs
```

插件入口导出 `apply(ctx, config)`；bundle 只包含 [`cordis.patch.yml`](cordis.patch.yml) 中的一条 loader 记录。

## 许可证

[MIT](LICENSE) © zzhaobh
