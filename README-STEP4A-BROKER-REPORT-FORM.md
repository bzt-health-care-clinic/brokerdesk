# BrokerDesk Step 4A — Broker MVR / DASH 普通表单（独立补丁）

基线：PR #3 `feature/broker-auditor-lan-pilot`，Step 3F / `d208c50`。
本包的目的只有一个：替换 Broker Review 中 MVR / DASH `summary` 的 JSON 编辑框，
改为可增删记录的普通表单。**本包没有修改 Auditor、BDZIP、SQLite 或默认 v0.3 流程。**

## 新增文件

- `components/broker-review-report-editor.tsx`：MVR/DASH Yes/No、逐条编辑、Add/Remove、Save
- `lib/broker-review-report-form.mjs` + `.d.mts`：字段转换、验证、保留已有解析元数据
- `scripts/install-broker-review-step4a.mjs`：定位并精确修改 `app/broker-review/page.tsx`
- `tests/broker-review-step4a.test.mjs`：新模块与已有 Step 3E 严格报告 Schema 的兼容回归

## Windows 安装

必须在已包含 Step 3E 的 PR #3 开发分支上操作，不在 main 上做。

```powershell
git fetch origin
git switch feature/broker-auditor-lan-pilot
git pull --ff-only origin feature/broker-auditor-lan-pilot
git switch -c feature/broker-step4a-ui

# 将 ZIP 解压到仓库根目录。仅新增文件，不要覆盖同名现有文件。
node scripts/install-broker-review-step4a.mjs --dry-run
node scripts/install-broker-review-step4a.mjs
git diff --check

node --test tests/broker-review-step4a.test.mjs
npx tsc --noEmit
npm run build
```

然后使用 `npm run broker:local`，打开 Broker Review 页面测试 MVR/DASH 历史分区。
用合成数据测试（不要上传客户原件到 GitHub 或 CI）：

1. MVR Unknown：不能保存为 No；确认后选择 No 并保存，明确的零记录有效。
2. MVR Yes：添加 2 个违章，仅输入 Offence Date、Offence Description、Classification。
3. DASH Yes：添加两个不同 Claim，核对 Claim #、Loss Date、Driver、Vehicle、At-fault %。
4. At-fault 0% 必须保存为零；空白不得当成零。
5. 在任一报告留有未保存改动时，不能离开分页或确认该分页；保存后能刷新恢复。
6. 打开旧的已经有解析结果的 Case，确认保存不会静默丢失报告的来源额外元数据。
7. 与 Step 3D/3E 的实际 BDZIP / Auditor 导入合成端到端回归一起跑。

## 重要边界

- Pulled Date 沿用原有独立日期字段；30 天时效的后台检查不变。
- 本包不改变 Step 3E 的 `validateReportSummary()` 严格服务端验证。
- Claim # 或驾驶人无法确认时不造数据。因现有校验要求 Claim #、Driver、Fault %，
  无法提供这些字段的报告仍不能确认；后续可独立设计“原件遮挡，需要补证”的例外流。
- 其他 `record` 类型仍保留 JSON 编辑，不在本段范围内。
- `.bdzip` 的 v0.4 opt-in 开关及默认 v0.3 行为均不改变。
- TypeScript 正式构建与实际 Chromium 点击测试仍需以你的 GitHub Windows CI 为准。

## 回退

该补丁只修改一个旧文件：`app/broker-review/page.tsx`，其余为新增文件。
提交以后优先使用 `git revert <step4a-commit>`；未提交的测试分支可以删除后重建。
不要在包含其他未提交工作时无条件执行 `git restore` 或覆盖文件。
