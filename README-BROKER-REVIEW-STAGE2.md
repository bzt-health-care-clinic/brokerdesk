# BrokerDesk — Step 2: Broker Review 页面与本地 API

适配基线：`770b786` 或包含该提交的后续开发分支。**不要在 main 分支或正在使用的生产副本上试装。**
该补丁只新增源文件，并提供一个一次性安装脚本向现有文件插入最小接入代码。安装脚本要求原有四个目标文件没有未提交修改，否则拒绝执行。

## 本段已实现

- `BrokerReviewService`：Broker 模式专用 REST API，创建草稿、按字段编辑保存、按分区确认、预览 Remarks、按当前 Case / PDF 重建草稿。
- SQLite `keyin_review_bindings`：为 Case 和原始文件、分段、解析结果绑定指纹；更改后禁止使用旧确认。
- `broker-review-source`：读取本机**真实原始文件字节**核对 SHA-256；有明确对象身份及页码来源才自动关联提取字段，重复 VIN / Licence 不自动归属；文件清单标记不能冒充对应 PDF 已上传。
- `/broker-review`：按统一分区分页、字段编辑（失焦保存）、车辆驾驶员及角色下拉选择、仅显示已存在的角色、Garaging、Coverage 条件展示、分区确认和 Remarks 自动起草；Pembridge 字数计数包括标点、空格和换行。
- 针对编辑、过期版本、指纹失效、原件替换、重复身份、Remarks 460 字符及 API 方法限制的自动测试。

## 暂未接入（后续 Step 3）

**此版本不改变现有 .bdzip、提交按钮、Auditor Inbox 或 Auditor Worksheet；Broker Review 的确认数据尚不会进入现有提交包。**
因此切勿将这个阶段的 Review 页提示当成已经完成生产交付。
`reviewed-keyin.json` 随包导出、导入重映射与 Auditor 直接 Key-in 是下个补丁的范围。

在本次 Step 2 中，“确认页面”只保存到 Broker 电脑本地 SQLite；既有 `.bdzip` 导出仍执行原规则。

## Windows 上的安装（PowerShell）

1. 确认本机使用 Node.js 22+，并从 `770b786` 之后的新分支安装：

```powershell
git switch feature/broker-auditor-lan-pilot
git pull
git switch -c feature/broker-keyin-step2
git merge-base --is-ancestor 770b786 HEAD
```

2. 把 ZIP 解压到仓库根目录（示例 ZIP 路径按实际下载位置替换）：

```powershell
Expand-Archive -LiteralPath "$HOME\Downloads\brokerdesk-step2-broker-review.zip" -DestinationPath . -Force
```

3. 验证接入位置后执行安装：

```powershell
node scripts/install-broker-review-step2.mjs --dry-run
node scripts/install-broker-review-step2.mjs
```

若提示 anchor 不匹配，说明仓库布局与本补丁预期不同，脚本会拒绝继续；请不要盲目手工覆盖。
脚本只修改这些已存在的文件：
- `local-server/server.mjs`（路由和 BrokerReviewService）
- `components/submission-panel.tsx`（Broker Review 链接）
- `components/broker-intake-panel.tsx`（说明文字）
- `app/page.tsx`（说明文字）

4. 先跑新增测试与原 Step 1 回归，然后运行项目自身构建/CI：

```powershell
node --test tests/broker-review-step2.test.mjs
node --test tests/broker-keyin-review.test.mjs tests/remarks-generator.test.mjs tests/reviewed-keyin-package.test.mjs
npx tsc --noEmit
npm run build
git status --short
```

5. 本地启动 Broker 模式，从 Submission 页面进入 Broker Review：

```powershell
npm run broker:local
```

或者在浏览器打开 `/broker-review?caseId=<实际 Case ID>`。首次选择 `Create Review Draft`，逐页编辑、确认；修改 PDF 或 Case 后会要求重新建立草稿。

## 测试与限制

- 原 ZIP 附带 16 项 `node:test` 测试；本轮代码审查额外增加 4 项防误填／身份绑定测试，目前 Step 2 共 20 项，独立沙盒 Step 1 + Step 2 合计 48 项通过。
- 独立沙盒另结合旧的 Step 1 28 项测试通过，共 44 项；**不是** Windows GitHub CI 的实际结果。本补丁还需你在完整仓库内运行 TypeScript、Next build 和浏览器测试。
- 分页是可用的初版。复杂 MVR / DASH 明细字段的高级表单（非 JSON 输入）、Signed Application 新版式识别、BDZIP 权威交付、Auditor Workspace 完善仍须后续迭代。
- 目前 Source Mapping 仅自动填入具备可靠 VIN / Licence / 地址和实际来源页码的字段；不能匹配的字段由 Broker 核实并补填，不做无证据猜测。
- 重建草稿**会清除当前 Draft 中人工编辑及已确认分区**。请先核对源 Case / 文件。
- 维持现有的 loopback-only 工作模式，不开启 LAN 或云上传。

## 代码清单

```text
app/broker-review/page.tsx
lib/broker-review-client.ts
local-server/broker-review-integration.mjs
local-server/broker-review-source.mjs
scripts/install-broker-review-step2.mjs
tests/broker-review-step2.test.mjs
README-BROKER-REVIEW-STAGE2.md
```

## 代码审查补丁与 GitHub 接入说明

- GitHub 开发分支已集成 4 处前后端挂钩，无需在该分支再次运行安装脚本；手工安装脚本保留供离线分支检查。
- 修改了车辆 Coverage deductible 的条件隐藏：字段 ID 在第一个 `.` 后分割，覆盖 Collision/Comprehensive/All Perils。
- 来源验证增加失效分段、页码超界、OCR 未核验、源文件待复核以及投保人身份不符的 fail-closed 保护；仍可人工核对并修正草稿。
- 驾驶人角色赋值不得引用 Case 中不存在的 Driver ID。
- 新增 Broker 页面实际打开、编辑、刷新后持久化的 Chromium 测试。BDZIP 与 Auditor 仍维持 Step 1 逻辑，不将此草稿视为权威提交。
