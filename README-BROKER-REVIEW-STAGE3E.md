# BrokerDesk — Step 3E 关键数据接线 / 校验补丁

**针对** PR #3 `feature/broker-auditor-lan-pilot`，基线 Commit `ce3be68`
（应用前请先确认当前 HEAD；后续提交如果改变锚点，安装脚本会停止，不会盲目覆盖）。

本包 **不覆盖现有业务文件**。只新增 4 个模块、1 个测试、安装脚本；运行安装脚本后按精确锚点对 6 个现有业务文件及 1 个旧合成测试文件做小范围改动。
不修改 `main`；不切换默认 v0.3；不触碰客户原件。

## 这次做的五个修复

1. **Review 自动填充接线**：`createOptions()` 现在传入现有 Case 及可信解析源能提供的逐车 Coverage、OPCF、部分驾驶员分配、garaging=mailing、已记录在 Case / Quote 中的折扣、MVR / DASH 拉取日期及报告明细、Home extras。
   - 只有 VIN 唯一匹配才应用车辆证据；没有明确角色时**不猜** Secondary/Occasional。
   - 同一文件多个 MVR/DASH 逻辑段拆成不同报告。
   - 折扣**仅**列出 Case 已明确选中或解析源显式列出的 Quote 折扣；目前解析器无法识别的其它折扣，仍需要 Broker 对照原 Quote 确认。不承诺“任意 Quote 全折扣自动识别”。
   - 所有自动带入的 Case 默认值仍为 `CASE_UNVERIFIED`，不能伪装成已人工确认。

2. **Reviewed Snapshot / Case 一致性**：对于可无歧义映射到现行 Case 的字段（仅单车或所有车辆共同的 Liability、All Perils Deductible、OPCF）安全投影到**出站 Case 副本**，并在打包校验时比对；不改 Broker 本地 Case。多车不同 Coverage 仍以 `reviewed-keyin.json` 为权威，旧的保单级 `coverage` 无法表达逐车差异，**不得宣称已同步为保单级规则结果**。现有 VIN、Licence 等 Step 3B 匹配与校验继续保留。

3. **Remarks 实际输入**：对明确指定了稳定车辆／驾驶员身份的变更，从 Broker Review 已编辑字段产生 Add Vehicle / Substitute / Remove / Add Driver 模板输入。包含 Vehicle Use、Annual KM、Commute (one-way)、Coverage、OPCF、Lienholder/Lessor；组合 Add+Delete 识别为 Substitute。无法准确关联时回到人工模板，不从车辆数量猜对象。Pembridge 460 字符仍由原生成器校验。

4. **Ownership 无 VIN 兜底封闭**：`validVehicleOwnership()` 不能只靠 `subjectId` 通过；必须看到该 Ownership 分段内明确、正确的 VIN。Step 3D 对不匹配 VIN 的拒绝仍保留。这是**保守拦截**：扫描件 VIN 无法读取时会要求重新提取／改善原件；本包**尚未实现**手工 VIN 核验的 byte-bound server attestation 路径，也不应让 Broker 客户资料进入外部 OCR。

5. **MVR/DASH 结构校验**：不能用 `{}`、`"No claims"`、不完整对象绕过。MVR 明确 `hasConvictions` 和 Convictions 明细（offenceDate/description/classification）；DASH 明确 `hasClaims` 和 Claims 明细（claimNumber/lossDate/driver/atFaultPercent）。记录为零必须显式 `false` 且 `[]`；有 Medium/High 解析警告的零记录不自动判定为干净。Pulled Date 的 30 天校验沿用现有逻辑。

## 重要：旧测试数据同步升级

旧 `tests/broker-keyin-review.test.mjs` 的两项合成报告示例使用纯文字：
`"No convictions"` / `"No claims"`。安装脚本会将它们替换为明确的结构对象。真实已有 Review 草稿如果存放旧字符串，需通过 **Rebuild** 重新确认本页。**不得**在数据迁移时把未知记录猜作 No。

## 安装与验收（Windows PowerShell，Node.js 24）

```powershell
git switch feature/broker-auditor-lan-pilot
git switch -c feature/broker-review-step3e
# 将 ZIP 直接解压至项目根目录（保持 lib/ local-server/ scripts/ tests/ 路径）
node scripts/install-broker-review-step3e.mjs --dry-run
node scripts/install-broker-review-step3e.mjs

node --test tests/broker-review-step3e.test.mjs
node --test tests/broker-keyin-review.test.mjs tests/broker-reviewed-case-projection-step3b.test.mjs tests/reviewed-keyin-package.test.mjs
npx tsc --noEmit
npm run build
git diff --check
```

建议 GitHub Windows Node 24 CI 中加：

```powershell
node --test tests/broker-review-step3e.test.mjs
```

并继续运行现有 Step 3D 合成 BDZIP / Ownership / Auditor End-to-End 测试和浏览器测试。
**本环境无法运行完整仓库、真实 Windows 安装、GitHub Actions 或客户 PDF；不要把本地合成测试误写成这些验收已通过。**

## 特别重要的补充测试

- Ownership **无可读 VIN** 但 `subjectId` 匹配的情况必须在真实 `authoritativeIntake()` 下拒绝。
- 新 VIN 及对应 Ownership 的完整 BDZIP 允许通过；旧 VIN 的 Ownership 必须拒绝。
- 多车不同 Coverage 在 Auditor 工作表按车辆显示正确；现有 policy-level Case 不会伪装成逐车 Coverage。
- 已确认的折扣目录对照原 Quote 人工抽检；解析器未显式列出全部折扣时仍是覆盖缺口。
- 对 `{hasConvictions:false, convictions:[]}` 和 `{hasClaims:false, claims:[]}` 的真实来源必须确认它们是原件明确报告的零，而不是文本读取失败。

## 回退

首次安装前务必用新分支且保持干净工作树。回退已修改的 tracked 文件：

```powershell
git restore lib/intake-profile.ts lib/broker-keyin-review.mjs lib/keyin-field-catalog.mjs `
  local-server/broker-review-integration.mjs local-server/reviewed-case-projection-stage3b.mjs `
  local-server/reviewed-keyin-package.mjs tests/broker-keyin-review.test.mjs
```

新增 4 个模块、安装脚本和测试可以在 Git 未提交时从文件系统删除，或提交后用 Git Revert 回退。**不要**对任何已存在的用户改动使用不经检查的 `git restore`。
