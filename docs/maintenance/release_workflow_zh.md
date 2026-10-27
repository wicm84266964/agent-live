# 发布流程

这个仓库由一个人维护。公开提交只放在 `open-source/agent-live`，试验目录 `agent-shield` 不直接当线上仓库。

1. 在试验目录改完，跑 `npm test`、`npm run check`、`npm run doctor -- --file real-events.json`。
2. 确认没有本机路径、原始转录、密钥、`.lab-agent/`。
3. 把干净文件同步到 `open-source/agent-live`。
4. 在镜像里再跑一次同样的检查。
5. 推送 `main` 之前看 diff。不推送未跑过检查的提交。

GitHub 仓库按 `https://github.com/wicm84266964/agent-live.git` 准备。仓库还没创建时，不要写“已发布”。

版本号用 `vMAJOR.MINOR.PATCH`。0.1.0 是第一份公开候选，不是“已支持每一家智能体”的声明。
