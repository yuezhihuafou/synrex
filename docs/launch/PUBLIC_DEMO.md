# Synrex public demonstration and recording guide

Use this guide for a Douyin/Xiaohongshu introduction. The goal is a repeatable
*real* demonstration, not a generated interface mockup or claimed benchmark.

## One-sentence positioning

**在普通 ChatGPT 对话中直接操作你自己的项目：Synrex 提供可检查、可恢复的远程代码执行能力。**

Synrex is a self-hosted tool layer. The AI host reasons; Synrex executes.
Do **not** describe it as an unlimited-token model, a model jailbreak, a
standalone AI agent, a free hosted API, or a guaranteed Codex replacement.

## Prepare the screen

1. Install on a machine you control, run `synrex doctor`, and verify the
   *authenticated* ChatGPT MCP connection. Do not show setup passwords.
2. Copy `examples/public-demo` into a disposable Git repository under an
   approved Synrex workspace root. Run `node --test` once: **one test is
   expected to fail**. This is an intentionally reproducible exercise.
3. Prepare the Synrex Console in a separate browser tab, using the existing
   Owner-authenticated session. Do not put the Console on an unauthenticated
   public route.
4. Disable notifications; use a clean browser profile; hide personal chat
   history, home directories, repository secrets, private endpoints, OAuth
   screens, cookies, access tokens, network inspector and raw private logs.
5. Verify the exact feature to be shown is present in the active running
   build. A source-only feature should not be presented as deployed.

## 60–90 second recording outline

| Segment | Screen | Narration (Chinese) |
| --- | --- | --- |
| 0–8 s | ChatGPT beside terminal | “我想让 ChatGPT 不只是回答代码问题，而是真的在我的电脑上完成工程任务。” |
| 8–25 s | Open the demo repository in Synrex | “项目在自己的机器上，GPT 通过 Synrex 读代码、定位问题。” |
| 25–48 s | Ask GPT to fix failing boundary test; show diff and test receipt | “修改后跑测试，保留结果和变更证据；不靠口头说‘已经修好了’。” |
| 48–65 s | Show bounded command/run history or a durable task handle | “长任务可以返回任务标识，之后再查询真实执行状态。” |
| 65–80 s | Authenticated Console overview or task timeline | “Console 用来查看实际执行与故障，不是另一个聊天机器人。” |
| 80–90 s | Repo homepage and compatibility caveat | “开源自部署，当前是 Linux 优先的公开预览版。” |

Only show the durable-task segment if it actually completed and the terminal
receipt is available. Never imply that GPT independently wakes up to continue
reasoning after the host turn ends.

## A reproducible chat prompt

> 打开我已经授权的 `public-demo` 仓库。先运行 `node --test`，
> 找到为什么满 100 元时没有免运费；最小修改代码，重新运行测试，
> 给出具体修改文件与最终测试结果。不要修改工作区外的文件。

The exercise is intentionally trivial: the differentiator being demonstrated
is the complete, verifiable conversation-to-execution loop, not an AI coding
benchmark. Capture the real run and avoid editing the failure/success footage
into a false outcome.

## Release wording for social posts

**Headline:** “我把 ChatGPT 接到了自己的开发机上：Synrex 开源自部署”

**Three claims you may make after live verification:** ChatGPT can inspect and
edit an authorized repository; Synrex can run commands and retain evidence;
an Owner-authenticated Console can show supported runtime status.

**Never claim without measurements:** “比 Codex 快 X 倍”, “绝不断流”,
“完全无人值守”, “无限 token”, “Windows/macOS 完全兼容”,
“所有模型和所有 ChatGPT 账号都能直接连接”。

**Xiaohongshu caption draft:**

> 做 Synrex 的起点，是想让普通 ChatGPT 对话能直接完成本机的代码任务。
> 它通过 MCP 接入自己授权的项目，可以读改代码、执行测试、追踪长任务、
> 留下可检查的结果；还能用 Console 看运行状态。不是新模型，也不提供
> 托管账号，目前更适合愿意自部署的开发者。仓库与安装说明见主页。

**Douyin voiceover draft:**

> 我没有重新做一个 AI 编程模型，而是给 ChatGPT 补了一层执行能力。
> 你看，这个故意写错边界条件的小项目，GPT 先检查，再修改，最后真实
> 跑测试。长命令和执行记录也能查询。Synrex 已经开源，目前是自部署
> 公开预览版。完整安装和限制都写在仓库里。

## Final pre-publication checks

- Confirm GitHub release version, source revision, package bytes and the
  live version separately. Never say “已部署” based on GitHub alone.
- Confirm all shown operations happened in the authorized demo workspace;
  the owner credential, domain internals and personal files must be hidden.
- Place the public GitHub URL (`https://github.com/yuezhihuafou/synrex`)
  and the exact supported installation guide in the pinned post/comment.
- If a test, connection or live demo failed, show its actual state or re-run
  it as a new, transparently identified take—never invent a receipt.
