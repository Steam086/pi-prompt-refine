可以。**对这个项目，推荐保留现有的 `modelRegistry.streamSimple()` 调用，通过 `onPayload` 只给请求体补充 `prompt_cache_key`，继续保持 SDK 的 `options.sessionId` 未设置。**

这样可以把服务端缓存标识与 Pi SDK 的连接生命周期分开：同一组请求使用稳定的 cache key，同时保持现有的 WebSocket 使用方式、并行请求、取消和 session 切换逻辑。

我核对了项目当前提交 [`5af2631`](https://github.com/Steam086/pi-prompt-refine/blob/5af2631e8392747e9c9162e84df86db95f788586/src/extension.ts)，以及 Pi SDK `v1.4.0`、`v1.5.0` 的相关实现。**两个版本都支持这个入口，无需修改 SDK。**下面给出具体改法，以及它能保证的范围。

## 1. 为什么 `onPayload` 可以避开你前面列出的副作用

关键在于，SDK 处理的是两份独立数据：

| 数据 | 本方案如何处理 | SDK 中的用途 |
|---|---|---|
| `options.sessionId` | 保持当前未设置的状态 | 连接缓存、session-affinity、fallback、continuation 等 |
| `body.prompt_cache_key` | 在最终请求体中补充稳定值 | 发送给服务端的缓存相关字段 |

Codex provider 的实际执行顺序是：

1. 从 **`options.sessionId`** 计算内部 `cacheSessionId`。
2. 构造请求体。
3. 调用 **`options.onPayload(body, model)`**，允许替换请求体。
4. 使用此前计算的 `cacheSessionId` 处理连接与 fallback。
5. 将修改后的请求体发送给 WebSocket 或 SSE。

**它不会在 `onPayload` 执行后，再从 `body.prompt_cache_key` 反向生成 SDK 的 sessionId。**因此，单独修改请求体，不会启用那些基于 sessionId 的客户端状态。[Codex 请求构造源码](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-codex-responses.ts#L280)

更具体地说，未提供 sessionId 时，Codex 仍走临时 WebSocket 连接，并在释放时关闭；只有拿到了缓存连接条目，才会尝试利用其 continuation 状态。这两点都不会因为请求体新增 cache key 而改变。[连接获取逻辑](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-codex-responses.ts#L1184)、[continuation 条件](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-codex-responses.ts#L1525)

标准 OpenAI Responses 也支持相同方式：先构造 client 和请求参数，再执行 `onPayload`，最后发送替换后的参数。[OpenAI Responses 源码](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-responses.ts#L185)

## 2. 建议的具体实现

建议把逻辑放在一个小 helper 中。第一版只对以下已核验组合启用：

- 官方 OpenAI provider 的 Responses API。
- 官方 OpenAI Codex provider 的 Codex Responses API。

其他 provider 和第三方代理保留原行为。这样不会因为它们“兼容 OpenAI 格式”，就默认它们也接受 `prompt_cache_key`。

### 新增 `src/prompt-cache.ts`

下面是建议代码：

```ts
import { createHash } from "node:crypto";
import type {
  Api,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

function supportsPromptCacheKey(model: Model<Api>): boolean {
  let origin: string;

  try {
    origin = new URL(model.baseUrl).origin;
  } catch {
    return false;
  }

  return (
    (
      model.provider === "openai" &&
      model.api === "openai-responses" &&
      origin === "https://api.openai.com"
    ) ||
    (
      model.provider === "openai-codex" &&
      model.api === "openai-codex-responses" &&
      origin === "https://chatgpt.com"
    )
  );
}

export function withPromptCacheKey(
  refineSessionId: string,
  options: SimpleStreamOptions,
): SimpleStreamOptions {
  // 保留显式关闭缓存的选择，也不为缺失的会话标识创建共享 key。
  if (!refineSessionId || options.cacheRetention === "none") {
    return options;
  }

  const previousOnPayload = options.onPayload;

  return {
    ...options,

    onPayload: async (payload, actualModel) => {
      // 兼容原有 hook：支持返回新对象，也支持原地修改后返回 undefined。
      const replacement = await previousOnPayload?.(
        payload,
        actualModel,
      );
      const body = replacement === undefined ? payload : replacement;

      if (
        !supportsPromptCacheKey(actualModel) ||
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body)
      ) {
        return body;
      }

      const record = body as Record<string, unknown>;

      // 保留已有设置，包括显式空字符串或 null。
      // SDK 可能生成 prompt_cache_key: undefined，因此不能用 in 判断。
      if (record.prompt_cache_key !== undefined) {
        return body;
      }

      const digest = createHash("sha256")
        .update(JSON.stringify([
          refineSessionId,
          actualModel.provider,
          actualModel.api,
          actualModel.id,
          actualModel.baseUrl,
        ]))
        .digest("base64url");

      return {
        ...record,
        prompt_cache_key: `prompt-refine:v1:${digest}`,
      };
    },
  };
}
```

这里有几个有意保留的细节：

**第一，检查的是 hook 收到的 `actualModel`。** Pi runtime 可能在模型路由或认证解析后调整实际模型、endpoint；在回调中检查，可以针对最终请求目标作判断。[runtime 的请求准备与路由](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/model-runtime.ts#L659)

**第二，key 总共是 60 个 ASCII 字符。** 前缀 17 个字符，完整 SHA-256 的无填充 base64url 编码 43 个字符，不依赖 SDK 的截断处理。SDK 原有工具只负责限制到 64 个 Unicode 字符，并不会替你哈希；通过 hook 写入的值也需要自己保证长度。[SDK 的 key 长度处理](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-prompt-cache.ts)

**第三，保留已有 hook 和已有 key。** 当前扩展没有 `onPayload`，但 helper 不必因此假设以后也没有。先执行旧 hook，再补缺失字段，可以减少后续组合功能时的冲突。

### 修改现有 `streamSimple()` 调用

在 `src/extension.ts` 中导入：

```ts
import { withPromptCacheKey } from "./prompt-cache.js";
```

然后将现有调用改为：

```ts
const response = await ctx.modelRegistry.streamSimple(
  model,
  { systemPrompt, messages: [userMessage], tools: [] },
  withPromptCacheKey(request.sessionId, {
    signal,
    maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
    ...(request.thinkingLevel && request.thinkingLevel !== "off"
      ? { reasoning: request.thinkingLevel }
      : {}),
  }),
).result();
```

**这里的 `request.sessionId` 只是哈希输入，没有写入 SDK options 的 `sessionId` 字段。**

同时，使用请求已经捕获的 `request.sessionId`，可以避免异步请求执行期间发生 session 切换后，错误读取新 session 的标识。

## 3. 这个 key 应该多稳定、覆盖多大范围？

对于你当前“同一 Pi 会话中，多次执行 prompt refine”的需求，上面的作用域比较合适：

```text
扩展命名空间
+ 当前请求所属的 Pi session
+ 实际 provider / API / model / endpoint
```

它产生以下行为：

| 操作 | key 是否变化 |
|---|---|
| 同一 session、同一模型，再次 refine | 不变 |
| 同一 session、同一模型，并行生成多个候选 | 不变 |
| 修改 draft 或追加历史 | 不变；实际复用范围由前缀匹配决定 |
| 同一 session 中进入新的 round | 不变 |
| 恢复同一个 session，模型配置也相同 | 不变 |
| 切换 session、模型或 endpoint | 改变 |

**不要把 `requestId`、`roundId`、时间戳、draft、历史计数或完整输入加入 key。**这些内容频繁变化，会把本应属于同一复用组的请求拆成不同 key。

我也不建议第一版对完整 `systemPrompt` 求哈希后加入 key。这个项目会根据是否需要生成 title，在 system prompt 尾部追加不同要求；保持 key 稳定，至少不会主动丢掉前部公共内容的复用机会。具体能缓存到哪里，仍由后端判断。[项目的 system prompt 构造](https://github.com/Steam086/pi-prompt-refine/blob/5af2631e8392747e9c9162e84df86db95f788586/src/context.ts)

如果以后目标变成**不同 Pi session 之间也复用同一套项目规则和改写模板**，可以将作用域改成“用户或工作区 + 扩展版本”，而不包含 sessionId。那是另一种分组策略；当前方案优先满足同会话复用。

## 4. 两个需要明确保留的行为

### 保留 `cacheRetention` 的现有选择

不要为了加 key，顺手固定：

```ts
cacheRetention: "short"
```

当前 OpenAI Responses 实现会在没有显式设置时读取 `PI_CACHE_RETENTION=long`。强制写 `"short"` 会覆盖原有选择。[缓存保留设置解析](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-responses.ts#L81)

另一方面，`onPayload` 在 SDK 的请求构造之后执行，手工补 key 可以绕过构造阶段对 `"none"` 的处理。因此 helper 显式检查：

```ts
options.cacheRetention === "none"
```

这里的意思是：**扩展不在调用者选择 `"none"` 时重新补 key。**它不代表能够统一关闭所有后端自身的缓存机制。

### 保留当前请求内容与输出协议

第一步只补请求字段即可。现有 system prompt、单条 JSON user 消息、历史选择、输出解析、取消和并行调度，都不需要为了设置 key 而调整。

因为这条路径不创建新的 SDK session 连接状态，**也就不需要为派生 cache key 新增 `cleanupSessionResources()` 调用。**

## 5. 设置成功，不等于所有历史都能复用

这里需要区分两个目标：

- **客户端正确发送稳定的 `prompt_cache_key`。**上述改法可以做到。
- **后端实际复用了多少输入计算。**需要查看缓存用量，不能仅由 key 推断。

项目当前的 JSON 输入中，`conversation.status` 和多个消息计数位于 `conversation.items` 前面；这些字段一旦变化，后面的历史文本即使大部分相同，也不再构成完全相同的连续前缀。此外，`operation` 位于 JSON 开头，从 `refine` 切到 `revise` 也会较早出现差异。这些都是输入布局带来的限制，固定 key 无法消除。[项目的 `buildRefineInput()`](https://github.com/Steam086/pi-prompt-refine/blob/5af2631e8392747e9c9162e84df86db95f788586/src/context.ts)

**为了满足你“不影响现有功能”的要求，建议把 JSON 重排或拆分消息留作单独的性能优化。**它们会改变模型实际看到的输入，应该与这次只补 key 的改动分开评估。

还有一个当前文档的版本差异：

| 公共 OpenAI API 模型范围 | 当前文档对 key 的说明 |
|---|---|
| GPT-5.6 以前 | 稳定 key 可以帮助缓存路由，但不保证命中 |
| GPT-5.6 及以后 | 缓存路由自动处理；key 可用于独立缓存核算，无需靠它优化路由 |

因此，不能统一承诺“加上 key 就会提高命中率”。新模型还涉及缓存断点规则，长公共前缀本身也不一定已经成为可复用的缓存条目。以上是公共 API 文档的说明，Codex 后端的具体效果仍需实测。[OpenAI API](https://developers.openai.com/api/docs/guides/prompt-caching?utm_source=chatgpt.com)

## 6. 如何确认既保留功能，又确实获得复用

建议分两层验收。

### 第一层：确认改动范围

在现有测试框架中，重点验证：

1. `streamSimple()` options 中仍没有新增 `sessionId`。
2. `signal`、`maxTokens`、`reasoning` 和请求上下文与修改前一致。
3. 对支持的 provider，payload 只新增预期 key。
4. 同 session、同模型的多次请求得到相同 key；不同 session 得到不同 key。
5. `cacheRetention: "none"`、第三方 endpoint、其他 provider、已有 key 都得到保留。
6. 现有取消、并行和 session 切换测试继续通过。

项目已有的检查入口是 `npm run typecheck` 和 `npm test`。[项目验证说明](https://github.com/Steam086/pi-prompt-refine/blob/5af2631e8392747e9c9162e84df86db95f788586/AGENTS.md)

### 第二层：观察服务端缓存统计

这个项目已经保留了：

```ts
response.usage.cacheRead
```

Pi 的 Responses 解析器会将服务端 `input_tokens_details.cached_tokens` 映射到该字段；项目的 `readTokenUsage()` 也已经保留 `cacheRead`，可以沿用现有 Usage 展示。[SDK 用量映射](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/src/api/openai-responses-shared.ts#L632)、[项目用量处理](https://github.com/Steam086/pi-prompt-refine/blob/5af2631e8392747e9c9162e84df86db95f788586/src/usage.ts)

实测时，先固定模型、思考设置、system prompt 和输入，等待第一次请求完成，再连续重复几次，观察 `cacheRead`。之后再测试“背景相同、draft 不同”的真实使用方式。

**先串行验证，确认缓存统计后再测并行。**冷启动时同时发出的请求，不能假设已经能够利用彼此尚未完成的缓存填充。也不能把一次命中归因于新加的 key，因为没有显式 key 时，后端也可能已经缓存了相同内容。

我对上面 helper 的独立运行逻辑做了本地检查：60 字符长度、key 稳定性、session 区分、原 options 和 payload 保留、provider 限定、`none`、已有 key，以及旧 hook 的组合均通过。**本轮未修改仓库，也未在你的 Pi 宿主和模型账号上做线上命中测试。**

对于当前项目，我会采用的就是这项范围很小的改动：**请求级 `onPayload` + 稳定的 60 字符 key + 官方 provider 限定；通过现有 `cacheRead` 验证效果。**
