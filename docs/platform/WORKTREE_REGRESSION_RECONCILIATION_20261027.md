# Synrex 系统回归与 Worktree 回收台账（2026-10-27）

本文件记录本轮源码与生产状态核验后的 **工作树实际归属**。未提交文件不自动发布，旧 commit 不因工作树清理而丢弃。

## 已执行的保护措施

- GitHub/main 和生产初始版本均为 `126a63cdbde19f80a022752628b970c872267700`；gateway 已通过现有 swy1 SSH LAN 完成 `main`/`origin/main` 无工作区修改的快进同步。
- 通过 `synrex worktrees prune --dry-run` 与 `--safe` 检查/清理生产状态库：可删除 0 个，6 个未跟踪文件工作树受到保护。
- 对独有源提交建立本地恢复引用 `refs/synrex/archive/20261027/<SHA>`：swy1 14 个，gateway 6 个；这不是将旧实现自动并入生产。
- 原有 recoverable prune、任务/运行记录、当前工作区状态和 Console/MCP/Cloudflare 全部保留。

## 重新核对的完整工作树

- swy1：45 个，脏工作树 14 个，非 main 祖先的独有 HEAD 14 个（包含本次用于集成的活动工作树）。
- gateway：10 个，脏工作树 6 个，非 main 祖先的独有 HEAD 9 个。

| 主机 | Worktree | HEAD | ahead/behind | tracked/untracked | 处理状态 |
|---|---|---|---|---|---|
| swy1 | `DevSpace` | `69f4ac9818` | 0/53 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-0571accb` | `1abf77083f` | 1/13 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-0d39e6ed` | `4f219da85b` | 0/94 | 53/60 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-19817826` | `fe712e2b6c` | 0/293 | 0/2 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-1f2124ce` | `0125b1a2ec` | 1/37 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-2079eace` | `d510ba8ff2` | 0/45 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-3844de94` | `fc6b0a5b56` | 0/87 | 0/1 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-4a45e557` | `5c8ce85be9` | 1/50 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-4d9f36a1` | `542501ca09` | 0/59 | 0/3 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-4fe5d08e` | `e4da797496` | 0/46 | 11/1 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-56fdfdf6` | `721e1da4d5` | 1/46 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-58538019` | `701806ce8a` | 2/19 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-65ea1395` | `c148b6a331` | 0/41 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-6a9820b6` | `d987fc0678` | 0/42 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-6da8535e` | `3a594ed6ce` | 0/37 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-793f2d35` | `10e11928db` | 0/10 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-7b03f818` | `e15bd92060` | 0/50 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-8191bc4f` | `126a63cdbd` | 0/0 | 5/1 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-830863d3` | `a7e23b61f0` | 0/45 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-85f252f4` | `e9114fbd9f` | 0/13 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-91a7d925` | `59c92467cd` | 0/46 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-94b56b49` | `a253055e31` | 1/42 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-9a802929` | `69f4ac9818` | 0/53 | 11/1 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-9e1299d4` | `c21a6b1150` | 1/53 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-a09a35fb` | `aa1e668d05` | 1/53 | 2/5 | 独有提交已归档；WIP 原位保护 |
| swy1 | `DevSpace-a5e16c32` | `d510ba8ff2` | 0/45 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-a97e0a18` | `69f4ac9818` | 0/53 | 0/1 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-b3fd255d` | `a3333d142b` | 5/53 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-b5952774` | `4f219da85b` | 0/94 | 1/2 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-b63fad9a` | `9438b6b8ed` | 0/15 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-bd4add3d` | `126a63cdbd` | 0/0 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-e90486bb` | `a0096ce2e3` | 1/53 | 1/1 | 独有提交已归档；WIP 原位保护 |
| swy1 | `DevSpace-e9eaf0b5` | `cbcf1df201` | 0/70 | 0/4 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-ea2f529e` | `c186f2cfee` | 0/12 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-ebcbfffb` | `fae1534373` | 1/50 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-f4cdd2e2` | `492e8c622e` | 1/15 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `devspace-task-protocol-serena` | `2887dd6536` | 0/104 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `DevSpace-7d956279-6d530463` | `cbcf1df201` | 0/70 | 0/4 | 未提交 WIP 原位保护 |
| swy1 | `DevSpace-7d956279-df2e4432` | `ee920a2e15` | 1/70 | 0/0 | 独有提交已归档；待选择性复核 |
| swy1 | `DevSpace-19817826-7e5912be` | `fe712e2b6c` | 0/293 | 0/4 | 未提交 WIP 原位保护 |
| swy1 | `build-v1-acceptance-20261021-3974a10` | `3974a10d19` | 0/80 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `build-v1-progress-legacy-v2-020ec03` | `020ec03ede` | 0/78 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `build-v1-recovery-3367d6a` | `3367d6a3b4` | 0/74 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `.staging-synrex-m1-v1` | `6d05d3f24f` | 0/93 | 0/0 | 源历史已在主线内；按活跃度保留 |
| swy1 | `candidate-src` | `860a1a592f` | 1/94 | 0/0 | 独有提交已归档；待选择性复核 |
| gateway | `DevSpace` | `bffd415ba6` | 1/53 | 14/46 | 独有提交已归档；WIP 原位保护 |
| gateway | `DevSpace-5902de48` | `bffd415ba6` | 1/53 | 7/5 | 独有提交已归档；WIP 原位保护 |
| gateway | `DevSpace-5917b5c0` | `4daea81e12` | 12/53 | 0/1 | 独有提交已归档；WIP 原位保护 |
| gateway | `DevSpace-5fbe95ac` | `a3333d142b` | 5/53 | 0/1 | 独有提交已归档；WIP 原位保护 |
| gateway | `DevSpace-8f6cb721` | `f7a14a76aa` | 10/53 | 0/0 | 独有提交已归档；待选择性复核 |
| gateway | `DevSpace-bb78b18a` | `584be814e6` | 6/53 | 0/1 | 独有提交已归档；WIP 原位保护 |
| gateway | `DevSpace-e3d6a2c7` | `a3333d142b` | 5/53 | 0/0 | 独有提交已归档；待选择性复核 |
| gateway | `DevSpace-e4ada141` | `4351ab2a80` | 13/53 | 0/0 | 独有提交已归档；待选择性复核 |
| gateway | `DevSpace-ffe8c1cf` | `bffd415ba6` | 1/53 | 10/3 | 独有提交已归档；WIP 原位保护 |
| gateway | `devspace-task-protocol-serena` | `2887dd6536` | 0/104 | 0/0 | 源历史已在主线内；按活跃度保留 |

## 处理原则

- 工作树已合并 ≠ 当前必须删除；工作树独有提交 ≠ 功能一定未合并。源 SHA 不同可能源于选择性合并或重实现。
- 含未提交改动或隐藏数据的工作树不得 `reset --hard`、`clean -fd` 或强制删除。
- Research Harness 独立于 Synrex Core，窗口/AGY/ROS2 实体设备任务不得自动重路由或以 Git 清理触发。
- 当前已完成的是主线基线与历史提交的可恢复性；每个尚未提交功能必须由其原对话工作区评估、测试，再选择性进入主线。

## 设计特性保护矩阵

| 特性 | 必须保持的行为 | 实际检查入口 |
|---|---|---|
| GPT 优先与多对话开发 | 正常 ChatGPT 仍负责推理；不同 Worktree 独立，共享物理目录写操作不能丢失 | `src/server.test.ts`、`src/workspace-operation-gate.test.ts`、`scripts/benchmark-parallel-workspaces.ts` |
| Git 主线与版本权威 | 拒绝旧候选覆盖新生产；保留用户 WIP；旧提交有可追溯恢复来源 | `tests/test_release_provenance.py`、`src/git-worktrees.test.ts`、`src/cli-worktrees.test.ts` |
| 稳定入口及 Tunnel 治理 | 唯一 swy1 OAuth/SQLite 主实例、固定 :7676 入口、Core :7677、可回滚与有限排空 | `scripts/ingress-gate.test.mjs`、`tests/test_activate_owner_release.py`、真实服务检查 |
| 持久任务独立运行 | Core 可换版本而独立任务继续；保存 task/run/receipt；有副作用请求不自动重放 | `src/durable-tasks.test.ts`、`src/task-final-barrier.test.ts`、真实 systemd |
| Console 实时观测与统计 | 进程/请求/网络/用量数据可追溯；不虚构模型侧隐私 Token 信息 | `src/console-snapshot.test.ts`、`src/console-usage.test.ts` |
| 多主机与项目节点绑定 | gateway 为可选算力；无配置时不得强制绑定；机器人工作仍归真实硬件主机 | `src/multinode/placement.test.ts`、`src/multinode/worker-client.test.ts` |
| MemHub/Serena/通用 Subagent | 可选适配且有界输出/降级机制；不能成为第二 OAuth/强制模型 | `src/memhub-memory-adapter.test.ts`、`src/local-agent-context-pack.test.ts` |
| 视觉和 ROS2 证据 | 只读图像/视频/ROS2 快照，不替代机器人运动安全校验 | `src/media-read.test.ts`、`src/observation/evidence.test.ts`、`src/ros2-camera-read.test.ts` |
| Git 安全回收 | 只有 clean + 已合并 + 过期 + 不存在可检测的 Linux cwd 占用的 Worktree 可以选择回收；只读预览不更改数据库或文件 | `src/git-worktrees.test.ts`、`src/cli-worktrees.test.ts` |

## 保留但暂不投产的工作

- gateway 根目录的 Research Harness 代码、私有 QA、节点本地配置属于独立应用/环境，不能因为工作树合并而直接混入 Synrex Core。
- 原有 gateway Windows/WSL 节点安装脚本依赖固定 SSH 地址和待核验的令牌传递路径；保留在原始工作目录，待独立安全测试后再逐步产品化。
- gateway 其他对话中的 `execution-outcome-loop`、`task-final-barrier` 等未提交实现，以及 swy1 旧 LearningStore/Console WIP，仍为受保护的开发内容。直接打开这些原工作区被 Synrex allowedRoots 拒绝；不通过 shell 绕开权限读取或发布。
- 未进行真实机器人运动、正式生产故障回滚演练或 ChatGPT 客户端端到端自动恢复的破坏性测试；这些功能不因静态测试通过而宣称已验证。

## 此次工具改动

- `synrex worktrees prune --dry-run`：只读预览，不修改 Git 引用、用户目录或工作区会话。
- `synrex worktrees prune --safe`：拒绝清理未合并、已修改、含用户隐藏状态或被活动 Linux 进程占用的工作树。仍遵循 3 天不活跃期限。
- 原 `synrex worktrees prune` 的 recovery-aware 行为保持兼容，以保留已有的恢复引用、已跟踪文件快照和补偿性恢复特性。
- `scripts/benchmark-parallel-workspaces.ts`：从 gateway 评估试验移植的本地只读结果基准；使用临时文件测试 1/2/4/8 会话共享/分离目录，并验证每次修改最终计数。
