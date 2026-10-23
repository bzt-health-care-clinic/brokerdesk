# BrokerDesk Step 4B — Auditor Structured Key-in (read-only)

基线：`feb2e4c` (Step 4A 独立分支)，或其后继的 PR #3 开发分支。
版本要求：v0.4 reviewed-keyin 导入已存在；默认 v0.3 继续保持原样。

## 目标

Broker 核对一次 → BDZIP v0.4 → Auditor 直接用已确认资料 Key-in。
这次仅改变**展示和复制**，不增加 Auditor 二次确认/审批，不改变原始 Case、
`reviewed-keyin.json`、哈希、数据库、Intake、BDZIP 或 Broker Review。

## 新文件

- `lib/auditor-structured-sheet.mjs`：从 v0.4 原始行构造只读业务视图；
- `lib/auditor-structured-sheet.d.mts`：TS 类型；
- `components/auditor-structured-keyin-panel.tsx`：按实体和报告展示、复制；
- `scripts/install-auditor-step4b.mjs`：只替换 Auditor 入口的两个精确代码锚点；
- `tests/auditor-step4b-structured.test.mjs`：业务与复制文本测试；
- `tests/auditor-step4b-installer.test.mjs`：dry-run/重复安装/锚点不匹配保护。

## 界面行为

1. 每位 Driver 独立显示。
2. 每辆 Vehicle 各自显示字段和对应 Coverage / OPCF。
   Assigned Drivers 采用 Driver Name → Role，绝不补造空 Occasional 等角色。
3. Quote Discounts 只显示提交快照里已有的项目。
4. MVR：Pulled Date、是否有违章、Offence Date、Description、Classification。
5. DASH：Pulled Date、Claim #、Loss Date、Driver、Vehicle、At-Fault %，
   以及原记录包含的额外字段。0% 保留，不聚合同一事故的不同报告视角。
6. Prior Insurance：最近一家与 Continuous Insurance 的 Broker 确认值。
7. Policy Change：Before / After / Effective Date 和纯文本 UW Remarks。
8. 分组/分区/整表均可复制，复制值与显示值共享同一数据模型。

未知、未提取的历史不能显示为 "No"。旧版 v0.3 工作表走原有逻辑，
不会贴上 Broker confirmed 标签。

## 建议集成步骤

**先**将 Step 4A 的已验收分支安全集成到 PR #3 开发分支，并让目标分支 CI 通过。
然后从目标分支创建 Step 4B 的独立测试分支：

```powershell
git fetch origin
git switch feature/broker-auditor-lan-pilot
git pull --ff-only origin feature/broker-auditor-lan-pilot
git switch -c feature/auditor-step4b
```

解压本 ZIP 至仓库根目录（会新增文件，不覆盖既有源码）。然后：

```powershell
node scripts/install-auditor-step4b.mjs --dry-run
node scripts/install-auditor-step4b.mjs
node --test tests/auditor-step4b-structured.test.mjs tests/auditor-step4b-installer.test.mjs
npx tsc --noEmit
npm run build
git diff --check
```

如果 dry-run 报 **anchor mismatch**，说明你本地 Auditor 入口与已核对版本不符；
**停止安装**，不要强行字符串替换。这不代表业务代码坏了，只是补丁拒绝未知版本。

安装只改动 `components/auditor-worksheet-panel.tsx`：
- `AuditorReviewedKeyinPanel` import → `AuditorStructuredKeyinPanel` import
- 已验证的 v0.4 ready 分支调用新组件

`components/auditor-reviewed-keyin-panel.tsx` 原版保留，可以安全回退。
`v0.3` 未导入确认快照的 fallback 代码不改。

## 建议 Windows/Chromium 验收

- 合成 v0.4 Auto Case：两车/两司机/不同 Coverage 与 OPCF，同页各自显示。
- MVR 至少一份 No、一份 Yes 并有 conviction；DASH 两条 Claim，含 0% at-fault。
- Quote Discount 不多出任何原报价未列项目。
- Policy Change：Before、After 和 Remarks 换行不丢。
- Copy all / Copy section 文本一致。
- 旧 v0.3 Auditor Inbox 仍采用原 Source-to-field worksheet。
- 继续运行 Step 3C/D/E、Step 4A、签字完整性、BDZIP、A–E smoke 回归。

## 已验证与尚未验证

已在隔离代码环境跑通 26/26 Node.js 合成/安装测试；新 React 组件
在最小化类型依赖的 TypeScript 检查下通过。

**未**在完整 BrokerDesk 仓库执行 production build 或 Windows/Chromium，
也**未**运行真实客户文件或办公室双电脑验收。

## 回退

在 Step 4B 独立测试分支，尚未提交时可恢复单个入口：

```powershell
git restore -- components/auditor-worksheet-panel.tsx
```

已提交时在独立分支使用 Git revert 或将旧 Auditor import 与 ready 分支
调用恢复为 `AuditorReviewedKeyinPanel`。不要覆盖 main，也不要切换默认 v0.3。
