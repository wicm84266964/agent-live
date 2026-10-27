# GitHub 发布流程

本仓库采用单人维护、CI 强制验收的流程。日常开发不直接推送 `main`。

## 修改代码

1. 从最新 `main` 创建主题分支，完成修改。
2. 本地运行 `npm test`、`npm run check` 和 `npm run doctor -- --file real-events.json`。运行环境为 Node.js 22，无需安装第三方依赖。
3. 检查提交清单，排除原始会话、凭据、本机路径、`.lab-agent/`、截图和运行输出；临时材料放到被忽略的 `tmp/`。
4. 推送主题分支并创建 Pull Request。
5. 等待必需的 `test suite` 检查变绿，解决 review conversation 后再合并。合并后自动删除主题分支。

不要求第二个人批准；CI 通过是不能跳过的批准条件，管理员也受约束。禁止强制推送和删除 `main`。

## 发布版本

1. 在 PR 中更新 `package.json` 版本、`CHANGELOG.md` 和 `docs/releases/vMAJOR.MINOR.PATCH.md` 发布说明。发布说明应包含新功能、验证和数据源限制。
2. 合并后，等待 `main` 该提交的 CI 通过。
3. 在 GitHub Actions 选择 **Create release**，选择 `main`，填写新的 `vMAJOR.MINOR.PATCH`；候选版如 `v0.0.2-rc.1` 还必须勾选 prerelease。
4. 工作流检查版本格式、与 `package.json` 一致、发布说明非空、同名 tag/Release 不存在，以及本次提交最新的 main push CI 成功。其他提交、PR 或无关检查的绿色结果不能代替。
5. 工作流为该提交创建 tag 和 GitHub Release。确认发布页面、版本号和标签目标一致。

公开 `v*` 标签由 GitHub ruleset 禁止修改和删除，无绕过者。不要手工创建、移动或覆盖公开 tag；修复用新版本。发布失败若已经留下 tag，不得删除重试同一版本，应检查状态并使用新版本继续发布。

`v0.0.1` 是启用统一流程之前发布的首个版本，保持原提交和发布内容不动。此前文档中的 `0.1.0` 是未发布候选标记。

## 验收范围

CI 执行单元测试、诚实性检查和样本 doctor，设置最小只读权限、10 分钟超时及并发取消。发布工作流按需获得写 Release 权限，不发布 npm 包。

浏览器观感、真实会话接入和平台实机体验仍需发布前人工验收。Codex 当前完成记录接入不能显示尚未完成的子智能体，发布说明不得声称完整实时生命周期支持。
