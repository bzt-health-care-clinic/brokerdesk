# BrokerDesk Step 3B — Reviewed Case safe outbound projection

**适用基线：** 已合并 Step 3A 的 `18b9ebc` 或后代提交；仅限 PR #3 的独立测试分支。
**交付类型：** 小范围源码补丁，**不是**生产发布，不会更新你现行本机程序。
**目标：** 避免 Broker 在 Review 中改正资料后，为了通过 `case.json` 一致性校验而在原 Case 再输入一次。

## 本段改变

- Broker 在 Review 分区已经确认的明确字段，可以映射至 **BDZIP 内的 Case 副本**。
- 原始 Broker Case、客户 PDF、确认快照和签字证据不会被此模块修改。
- 涉及 Named Insured、Policy # / 日期 / 地址、指定 Driver/Vehicle 的部分基本字段，以及 Policy Change Remarks、明确 ID 的 Before/After 和日期。
- VIN / Licence Number 发生变化时，必须拥有稳定的内部实体 ID；没有 ID 时安全拒绝同步，绝不靠姓名或数组顺序猜测人车身份。
- 修改后校验唯一 VIN / Licence Number；出现重复立即阻断。
- 在 Broker Preflight、生成 BDZIP 时均以投影后的 Case **重新运行原有 authoritativeIntake()**。既有签字 / Ownership / 文件校验仍然适用。
- `prepareReviewedExport()`、哈希、来源指纹、事务冻结及 Auditor 导入规则均由 Step 3A 原逻辑继续执行。
- v0.4 仍需显式开启 `BROKERDESK_REVIEWED_KEYIN_V04=1`；默认 v0.3 不受影响。

## 未覆盖（刻意不猜）

- 自动新增 / 删除 Driver、Vehicle 或改写其内部关联 ID
- Driver Assignments、OPCF、Discount、MVR / DASH / Claims 的底层 Case 转换（完整数据仍在已确认的 `reviewed-keyin.json` 中）
- 变更公司、变更 Change Type、重指派 Change Subject、无稳定 ID 的 Change Item
- 把签字证据强制改成符合新值，或绕过 UW / 文件门禁

上述情况出现时，应在原始 Case 中进行明确修改并重建 Review，或者按下一阶段的专门 UI 流程处理。

## 文件列表

- `local-server/reviewed-case-projection-stage3b.mjs` — 纯函数，不修改原 Case
- `scripts/broker-review-step3b-patch.mjs` — 安全、幂等的源码锚点转换
- `scripts/install-broker-review-step3b.mjs` — Git 分支 / 基线 / 原文件干净检查、dry-run、安装
- `tests/broker-reviewed-case-projection-step3b.test.mjs` — 21 项单元场景
- `tests/broker-reviewed-case-installer-step3b.test.mjs` — 6 项安装脚本场景
- `tests/broker-reviewed-case-compat-step3b.test.mjs` — 2 项 Step 3A 一致性兼容场景

安装脚本只修改两个已有文件：
- `local-server/submission-service.mjs`
- `.github/workflows/lan-pilot-submission.yml`

## Windows 安装测试（PowerShell）

```powershell
git switch feature/broker-auditor-lan-pilot
git switch -c feature/broker-keyin-step3b
```

先把 ZIP **解压到仓库根目录**，确保 `git status` 中没有你尚未保存的已有文件修改，然后：

```powershell
node scripts/install-broker-review-step3b.mjs --dry-run
node scripts/install-broker-review-step3b.mjs

node --test tests/broker-reviewed-case-projection-step3b.test.mjs tests/broker-reviewed-case-installer-step3b.test.mjs tests/broker-reviewed-case-compat-step3b.test.mjs
node --check local-server/submission-service.mjs
npx tsc --noEmit
npm run build
git diff --check
```

审核源码 diff 后提交至测试分支，再运行 GitHub Windows CI、Broker Chromium、Auditor Inbox、A–E、签字及文档回归。
安装脚本还向现有 Windows CI 增加 Stage 3B 的专项 Node 测试。

## 必须完成的合成端到端测试

1. 使用**稳定内部 vehicle.id** 的 New Auto：Broker Review 修改 VIN，完成分区确认，v0.4 导出，应成功；解包后 `case.json` 和 `reviewed-keyin.json` 一致。
2. 同样的合成 Case 未配置稳定 vehicle.id：修改 VIN 必须被拒绝，而不是猜测关联。
3. 修改 Driver Licence Number 和 Named Insured：确认后重新运行全部现有 Intake/签字检查，失败必须明确展示 blocker。
4. 同时将两个 Vehicle 改成相同 VIN，或者两个 Driver 改成相同 Licence：导出必须拒绝。
5. Policy Change：Remarks / Effective Date / Change After 采用已确认值，Auditor 工作表与 BDZIP Case 保持一致。
6. 关闭 v0.4 开关：旧 v0.3 打包和导入不改变。
7. 操作任一步骤后 Broker 原始本地 Case 不发生静默覆写。

## 质量与回退

本补丁在隔离合成环境下通过新增 **29/29** 项测试（21 + 6 + 2），并对生成的模拟集成代码执行了 `node --check`。
**尚未运行用户真实仓库的 Windows 全量构建/浏览器验收，也没有实测真实客户文件。**
CI 的最终结果应以你在 GitHub 的运行日志为准。

回退方式：由于只在新分支安装，可 `git switch` 回 Step 3A 的分支/提交。不要对已有真实 SQLite 做重置或清理。

**隐私：** 本包的示例 VIN 是人工构造的合成字符串；不包含客户原件、账单或账户数据。
**完整性边界：** SHA-256 是包完整性校验，不是 Broker 身份数字签名。
