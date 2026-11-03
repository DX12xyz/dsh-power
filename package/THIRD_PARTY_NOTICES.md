# Third-Party Notices

本包（`@local/dsh-power` 1.8.2）在**设计思想与结构**上借鉴了下列开源项目。仅借鉴设计思想，未复制源代码；本项目以 MIT 公开发布。

## 运行时依赖说明

- 本包**没有 npm 运行时依赖**：`index.js`、`host/*.js`、`client.js` 以及 `relauncher*.mjs`、`quit-desktop.mjs`、`force-reaper.mjs`、`scripts/restart-cli.mjs` 只使用 Node.js 内置模块（`node:fs`、`node:path`、`node:child_process` 等）。
- `client.js` 中的 `React` 由 DSH Web 客户端运行时注入，不是本包的依赖。
- 可选的逃生舱插件是**另一个独立包** `@local/dsh-escape-pod`；本包只在关机时通过 Host 服务 `escapePod` 调用它，不 import 它，也不把它的第三方依赖带入本包。逃生舱的第三方声明见其自己的 `THIRD_PARTY_NOTICES.md` 与 README。

## dsh-tray-restart

- 来源仓库：<https://github.com/hxh230802/dsh-tray-restart>
- 许可证：MIT License
- 版权行：Copyright (c) 2026 dsh-tray-restart contributors
- 借鉴内容（结构/工程纪律，非实现手段；自 1.7.4-hotfix.5 起）：外部 CLI 入口、boot 对账 + hold、`status.json` 快照、fail-closed 校验 / dryRun、隔离目录测试、幂等 marker。
- 未借鉴内容：改写 `app.asar`、等长文本补丁、零确认重启、硬编码菜单、自动无审批修改安装目录、只有整应用重启。

## MIT License（原文）

```text
MIT License

Copyright (c) 2026 dsh-tray-restart contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
