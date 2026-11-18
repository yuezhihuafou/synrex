(() => {
  "use strict";

  const zh = {
    skip: "跳转到正文",
    navFeatures: "核心能力",
    navHow: "工作原理",
    navStart: "开始使用",
    heroEyebrow: "开源 / 自托管 / GPT 优先",
    heroLineOne: "AI 负责思考。",
    heroLineTwo: "自己的机器负责执行。",
    heroDescription: "让普通 ChatGPT 对话真正参与工程工作。Synrex 将模型连接到你自己的代码仓库与执行环境，支持持久任务、可核验结果和可恢复的工作流程。",
    ctaRelease: "获取最新版本",
    ctaQuickstart: "查看快速开始",
    heroNote: "无需托管账户，无需第二个 AI Agent。项目和执行权限由你掌控。",
    diagramLabel: "示意流程",
    diagramTitle: "完整的工程执行闭环",
    traceOne: "选择已授权的代码仓库",
    traceTwo: "理解真实源码",
    traceThree: "执行测试、构建与长任务",
    traceFour: "检查状态、日志与修改差异",
    diagramFooter: "执行证据，而不只是“已完成”",
    diagramDisclaimer: "工具调用流程示意，并非实时执行日志或性能测试结果。",
    stripOne: "原生 MCP 接入",
    stripTwo: "用户自主控制",
    stripThree: "持久化执行",
    stripFour: "MIT 开源许可",
    featuresEyebrow: "解决实际问题",
    featuresTitle: "为连续的工程任务而设计。",
    featuresSubtitle: "不是另一个聊天界面，而是面向真实代码仓库中复杂、多步骤工作的可靠执行层。",
    cardOneTitle: "长任务不必困在一次工具调用里。",
    cardOneText: "命令可以独立于单次 MCP 响应继续运行。持久任务标识、检查点和可检索日志让未完成的工作保持可追踪。",
    cardTwoTitle: "结果必须可检查。",
    cardTwoText: "查看具体改动、执行结果和失败原因。通过代码差异与执行记录核验成果，而非直接相信成功提示。",
    cardThreeTitle: "使用自己的开发环境。",
    cardThreeText: "在自托管设备上的授权工作区执行任务，并按需连接兼容的其他节点处理工程工作。",
    cardFourTitle: "上下文有范围，修改有边界。",
    cardFourText: "工作区级工具、隔离 Git 工作树、架构检查与精简输出，帮助管理复杂的代码修改。",
    architectureEyebrow: "工作机制",
    architectureLineOne: "保留模型推理。",
    architectureLineTwo: "掌控工程执行。",
    architectureDescription: "ChatGPT 仍然负责可见的推理、规划与决策。Synrex 提供认证工具、工作流状态及对执行节点的受控访问。它不会偷偷启用第二个 AI Agent，也不承诺在对话结束后自动唤醒 ChatGPT。",
    architectureLink: "阅读正式产品契约",
    architectureReason: "规划与审核",
    architectureExecute: "工具 · 任务 · 证据",
    architectureMachines: "你的设备",
    architecturePeers: "代码仓库 · 可选节点",
    startEyebrow: "开始使用",
    startTitle: "从源码安装到第一项任务。",
    startSubtitle: "建议先在临时测试仓库体验。Linux 是主要支持环境；macOS 和 Windows 存在平台限制。远程连接前必须完成认证配置。",
    quickstartLabel: "源码安装 / NODE 22.19+ / PNPM 11.25.0",
    copy: "复制命令",
    trialLink: "分步试用指南",
    portableLink: "固定版本安装指南",
    demoLink: "可复现实机演示",
    closingEyebrow: "开放开发",
    closingTitle: "展示真实能力，也说明限制。",
    closingText: "Synrex 仍处于独立维护的早期开放发布阶段。广泛第三方部署验证及严格的性能对比还在进行。欢迎提交可复现问题，帮助完善证据。",
    issueLink: "反馈问题",
    footerTagline: "面向 AI 的可治理执行平台。开源、自托管。",
    footerReleases: "版本发布",
    footerContribute: "参与贡献",
    footerAttribution: "Synrex 基于 Waishnav/DevSpace 衍生并独立维护，保留 MIT 许可与原作者署名，非 DevSpace 官方发行版。",
    copied: "已复制安装命令。",
    copyFailed: "无法自动复制。请选中上方命令手动复制。"
  };

  const textNodes = Array.from(document.querySelectorAll("[data-i18n]")).map((element) => ({
    element,
    key: element.dataset.i18n,
    english: element.textContent
  }));
  const switchButton = document.getElementById("language-switch");
  const copyButton = document.getElementById("copy-commands");
  const copyFeedback = document.getElementById("copy-feedback");
  let currentLanguage = "en";
  let copyState = "";

  function updateCopyFeedback() {
    const english = {
      copied: "Installation commands copied.",
      copyFailed: "Automatic copy is unavailable. Select the commands above to copy them."
    };
    copyFeedback.textContent = copyState ? (currentLanguage === "zh" ? zh[copyState] : english[copyState]) : "";
  }

  function setLanguage(language) {
    currentLanguage = language === "zh" ? "zh" : "en";
    const chinese = currentLanguage === "zh";
    for (const entry of textNodes) {
      entry.element.textContent = chinese ? (zh[entry.key] || entry.english) : entry.english;
    }
    document.documentElement.lang = chinese ? "zh-CN" : "en";
    document.title = chinese ? "Synrex — 面向 AI 的可治理执行平台" : "Synrex — Governed execution for AI";
    switchButton.textContent = chinese ? "English" : "中文";
    switchButton.setAttribute("aria-label", chinese ? "Switch to English" : "切换到中文");
    switchButton.setAttribute("aria-pressed", String(chinese));
    copyButton.setAttribute("aria-label", chinese ? "复制安装命令" : "Copy installation commands");
    updateCopyFeedback();
    try { localStorage.setItem("synrex-language", currentLanguage); } catch (_) { /* storage is optional */ }
  }

  async function copyCommands() {
    const value = document.getElementById("install-commands").textContent.trim();
    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch (_) { /* Fall back to selection-based copying. */ }
    }
    if (!copied) {
      const temp = document.createElement("textarea");
      temp.value = value;
      temp.setAttribute("aria-hidden", "true");
      temp.style.position = "fixed";
      temp.style.top = "-9999px";
      document.body.appendChild(temp);
      temp.select();
      try { copied = document.execCommand("copy"); } catch (_) { /* Preserve selectable source. */ }
      temp.remove();
      copyButton.focus();
    }
    copyState = copied ? "copied" : "copyFailed";
    updateCopyFeedback();
  }

  let saved = "";
  try { saved = localStorage.getItem("synrex-language") || ""; } catch (_) { /* Browser may disable storage. */ }
  const browserLanguage = (navigator.language || "").toLowerCase();
  setLanguage(saved === "zh" || saved === "en" ? saved : browserLanguage.startsWith("zh") ? "zh" : "en");
  switchButton.addEventListener("click", () => setLanguage(currentLanguage === "en" ? "zh" : "en"));
  copyButton.addEventListener("click", copyCommands);
})();
