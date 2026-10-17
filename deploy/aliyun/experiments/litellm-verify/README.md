# LiteLLM 验证

验证"用 LiteLLM 统一接入所有模型、由 LiteLLM 计价，再同步到 Paperclip"（方案 B）是否可行。只在本机运行，不进生产部署。结论记录在 [REPORT.md](./REPORT.md)。

## 组成

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | LiteLLM 1.105.1（固定镜像摘要）+ 它自己的 PostgreSQL + 假上游 `capture` |
| `config.yaml` | 模型接入与**测试单价**（输入 $1/M、缓存命中 $0.10/M、缓存写入 $2/M、输出 $4/M，不是真实价格） |
| `capture.mjs` | 假的 Anthropic 接口：记录 LiteLLM 发往上游的请求头，返回固定用量（1000 输入 / 5000 缓存命中 / 300 缓存写入 / 200 输出） |
| `verify.mjs` | 启动环境、建虚拟 Key、用 Claude Code 实际调用、读取 LiteLLM 花费记录并核对 |
| `results/` | 每次运行的结果：`run-<时间>.md`（摘要）和 `.json`（原始数据，不含任何 Key） |

## Key 放在哪

上游 Key 只放在 `~/paperclip-local/litellm/keys.env`（权限 600，不在仓库里）。第一次运行 `verify.mjs` 会从 `keys.env.example` 复制出这个文件。LiteLLM 管理员 Key 自动生成在同目录的 `master.env`。

| 变量 | 填什么 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 开放平台的 Key（按量） |
| `KIMI_CODING_API_KEY` | Kimi Code 控制台创建的会员 Key |
| `MINIMAX_CODING_API_KEY` | MiniMax 编程套餐的 Key |

留空的模型会被跳过。MiniMax 的模型名在 `config.yaml` 中写的是 `MiniMax-M3`，套餐不同时改那一行。

## 运行

```sh
node deploy/aliyun/experiments/litellm-verify/verify.mjs          # 跑全部检查
node deploy/aliyun/experiments/litellm-verify/verify.mjs --down   # 停止并删除数据
```

每个真实模型会用 Claude Code 各调用两次（一句话提示），消耗很少的额度。

## 检查项

1. **请求头与标签**（假上游）：上游收到的 User-Agent；`x-` 开头的自定义头能否转发；`x-litellm-tags` 是否进入花费记录。
2. **单价**（假上游）：缓存命中、缓存写入是否按各自单价计算。
3. **预算**（假上游）：虚拟 Key 设 $0.005 上限，第 3 次调用是否被拒。
4. **真实模型**（需要 Key）：Claude Code 经 LiteLLM 能否正常工作；缓存 token 是否被记录；是否按配置单价计价；LiteLLM 与 Claude Code 统计的 token 是否一致。

第二阶段（接入本地 Paperclip，验证按运行 / 项目归集花费）在第一阶段通过后再做。
