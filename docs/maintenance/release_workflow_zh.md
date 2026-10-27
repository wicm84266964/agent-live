# 发布流程

直接在 `wicm84266964/agent-live` 的克隆目录准备发布，临时验证文件放在被忽略的 `tmp/`。

1. 改完后，跑 `npm test`、`npm run check`、`npm run doctor -- --file real-events.json`。
2. 确认没有本机路径、原始转录、密钥、`.lab-agent/`。
3. 更新 `package.json` 版本和发布记录，检查待提交文件。
4. 提交通过验证的代码。
5. 推送 `main` 之前看 diff。不推送未跑过检查的提交。

GitHub 仓库按 `https://github.com/wicm84266964/agent-live.git` 准备。仓库还没创建时，不要写“已发布”。

版本标签用 `vMAJOR.MINOR.PATCH`。首个正式 GitHub Release 为 `v0.0.1`；此前文档中的 0.1.0 是未发布的候选标记。发布后核对标签对应提交和 Release 页面。
