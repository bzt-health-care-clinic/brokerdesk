# BrokerDesk Step 3A — Reviewed Key-in v0.4 BDZIP → Auditor

基线：`119c76e` 或其后代；只在 PR #3 的独立开发分支安装。
这是一段**可选择启用的集成补丁**，不是对 `main` 或现行本机程序的更新。
Step 1/2 代码与依赖必须已在仓库中。

## 本段功能（v0.4 opt-in）

1. Broker 必须完成当前 Review 所有必需分区确认，且 Case、文件字节、逻辑分段和解析证据没有过期。
2. v0.4 开关打开时，Intake Preflight 也显示 Broker Review 未完成造成的 blocker；不能在未确认时生成 v0.4 包。
3. 点击现有 Generate Submission Package 在同一笔 SQLite 事务中冻结 Review 快照、写入出站记录及审计记录（任一步失败均回滚），生成新的 `reviewed-keyin.json`，并在 manifest 中登记字节 SHA-256、Snapshot SHA-256、Schema/Catalog 版本和 Broker ID。
4. ZIP 验证器只新增一个顶层文件名白名单项，不放宽路径/CRC/解压上限等保护。
5. Auditor 验证整包哈希 + 原始 Case/文件/Review 一致性。仅在成功导入后，将原始快照和新 ID 对应的工作表原子存入 SQLite。
6. 导入的新 v0.4 Case，在现有 Auditor Worksheet 位置显示 Broker-confirmed Key-in；支持 Copy All、Copy Section 和 Copy Field，无需逐字段 Confirm。车辆驾驶员显示「姓名 — Principal/Secondary/...」，只显示实际存在的分配。
7. 旧版 v0.3 包可以导入，但不会被标记为 Broker 已确认；继续显示旧 Worksheet。

**注意**：本段保留 fail-closed 一致性检查：Broker 在 Review 更正 VIN、驾照号、被保人或保单号后，如果与原 Case 核心字段仍不一致，v0.4 打包会拒绝，而不会替你静默改写原 Case；需先在 Case 中一致地修正。这种自动同步/单次录入体验尚未在 Step 3A 完成。\n\n**注意**：现有字段目录仍可能需要补齐部分复杂 Signed Application / MVR / DASH 字段。成功打包验证的是当前版本 Catalog 的完整确认，不应宣称已证明所有保险公司字段覆盖率。全业务验收需真实脱敏或仓库外客户样本。

## 安装（Windows PowerShell）

先确认 `git status` 干净，创建独立开发分支：

```powershell
git switch feature/broker-auditor-lan-pilot
git switch -c feature/broker-keyin-step3-v04
```

将本 ZIP 解压到 BrokerDesk 仓库根目录（只覆盖新文件；不要以 ZIP 中的文档覆盖客户文件），在根目录运行：

```powershell
node scripts/install-broker-review-step3.mjs --dry-run
node scripts/install-broker-review-step3.mjs

node --check local-server/reviewed-keyin-stage3.mjs
node --check local-server/submission-service.mjs
node --check local-server/server.mjs
node --test tests/broker-reviewed-bdzip-step3.test.mjs
npx tsc --noEmit
npm run build
git diff --check
```

安装脚本会拒绝旧版分支、已修改的目标文件或不符合预期的源码锚点；
是 `--dry-run` 不会修改已有源码；重复安装不会插入第二份代码。
脚本修改的已有文件：

- `local-server/bdzip.mjs`
- `local-server/submission-service.mjs`
- `local-server/server.mjs`
- `components/auditor-worksheet-panel.tsx`
- `.github/workflows/lan-pilot-submission.yml`

其余是本 ZIP 中纯新增文件。

## 如何启用一次 v0.4 测试

在 **Broker 电脑/进程** 开启（仅限测试）：

```powershell
$env:BROKERDESK_REVIEWED_KEYIN_V04="1"
npm run broker:local
```

正常确认各分区，再在原 Submission 页面运行 Preflight、Generate BDZIP。
若 Review 未完成/来源已变更，Preflight 或 Export 会拦截。
首次成功打包时，会冻结该 Case 的 Review；再次更改业务资料必须建立新的 Case 修订，不能直接编辑已冻结的旧快照。

在 **Auditor 进程** 无需开启开关：新版导入器可以识别 v0.3、v0.4。导入 v0.4 后进入该 Case，Auditor Worksheet 会自动切换成已确认工作表。旧包照旧。

关闭开关：

```powershell
Remove-Item Env:\BROKERDESK_REVIEWED_KEYIN_V04 -ErrorAction SilentlyContinue
```

**不要在正式数据上试验首次 v0.4 打包**：因为打包会持久冻结 Review。
请使用合成测试或独立隔离测试库，不把客户原件上传 GitHub/CI。

## 必须做的验收（合成样本）

- 未确认分区：Preflight 显示 blocker；Export 失败，不能产生 v0.4 包。
- 正常 Broker 确认：v0.4 包含 `reviewed-keyin.json`，Manifest 完整且字段已确认。
- 篡改 `reviewed-keyin.json` / VIN / 原件 / Manifest：导入拒绝，不创建 Inbox Case。
- 同一个包重复导入：不新增重复 Case；来源哈希与原始确认快照不变化。
- 导入 ID 重映射：证据打开对应 Auditor 本地文件，原始 Broker 快照保持原哈希。
- v0.3 旧包仍导入，但**不能显示 Broker confirmed**。
- Windows `tsc --noEmit`、`npm run build`、A–E、Broker/Auditor Chromium、签字完整性和解析回归全绿。

GitHub CI 安装脚本增加了 `Broker reviewed v0.4 package and Auditor import` 专项 Node test；
现有 v0.3 旧流程测试仍照常运行。

## 已运行与未运行的区分

- 本地：Step 3 新增 13 项 Node 合成测试通过；在 Step 1/2 离线测试模块环境下重跑总回归通过。
- 本地：安装脚本在 **模拟旧版锚点的隔离 Git 仓库**中测试了 dry-run、安装、幂等与修改后的基础语法。
- 未执行：你 GitHub 仓库的完整 Windows build、浏览器 E2E、真实 PDF 全字段准确率、真实邮件/部署。
- 无直接 Git 写入权限：需要由你在当前开发分支安装并跑 Actions。

## 回退

安装后先不要合并 `main`。如需回退：切换回安装前的分支/提交，
或在新分支用 `git restore` 撤销安装脚本修改的五个旧文件并删除新增文件。
不要直接删除已有本机 SQLite；新增表不会影响旧版的读取，但测试应始终使用隔离数据库。

**隐私边界**：本补丁不会上传原件到外部 API；BDZIP 本身包含客户原件与已确认 Key-in 值，手工发送时需遵守你们批准的敏感资料传输方式。SHA-256 防止损坏，不证明 Broker 身份真实性。

## 额外代码审查修复（2026-10-22）

- 新增 `freezeReviewedExportInTransaction`，将 Broker Review 永久冻结与 `outbound_submissions` / 审计日志置于同一 SQLite `BEGIN IMMEDIATE` 事务。失败时自动回滚，避免「没有成功交付，却被冻结无法修改」。
- Step 3A 回归增加失败回滚、成功提交、并发修改/身份冲突三项；原有 v0.3 路径仍保持默认。
- CI 单独验收 v0.4 交付路径；v0.3 包不得携带 reviewed-keyin，v0.4 包不可绕过 Manifest/CRC/SHA-256/Intake/签字/Ownership 验证。
