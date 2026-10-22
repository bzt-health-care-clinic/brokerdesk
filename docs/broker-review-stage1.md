# BrokerDesk Step 1 — Broker Review Core (patch)

适用目标：`bzt-health-care-clinic/brokerdesk` 的
`feature/broker-auditor-lan-pilot` 分支。
以 2026-10-22 所见的 `insurance-types.ts`、`local-server/database.mjs`、
`local-server/submission-service.mjs` / Node 22 为基线。

## 这是第 1 段，不是可上线的完整功能

这一段是**纯新增文件、不会覆盖项目已有文件**的可测试基础模块：

- `lib/keyin-field-catalog.mjs`：统一 Auto/Home/Policy Change 分区和基础字段。
  Vehicles 页面保留驾驶员归属、Garaging=Mailing、逐车 Coverage、Quote 上的 Discount。
- `lib/broker-keyin-review.mjs`：Broker 分区确认、源文件哈希绑定、修改失效、
  字段完整性和 MVR/DASH 报告日期 30 天检查、确认快照校验。
- `lib/remarks-generator.mjs`：车辆新增/替换/删除、驾驶员新增、地址变更、
  银行账户变更、取消保单的纯文本 Remarks；使用 one-way commute km、
  Annual KM、Coverage、OPCF；Pembridge 460 字符（含空格/换行/标点）限制。
  不编造缺失信息，也不自动截断 VIN。
- `local-server/broker-review-store.mjs`：SQLite 本地持久化适配器，
  延用现有 `cases(id)`、`audit_events` 结构，事务/版本冲突保护。
- `local-server/reviewed-keyin-package.mjs`：`reviewed-keyin.json` 
  校验/序列化、原始 ID 保留与 Auditor 显示 ID 重映射的桥接模块。
- `tests/*.test.mjs`：32 个独立自动测试（含规则边界回归），仅用合成数据。

### 本阶段**没有**完成的工作（不能当成线上可用）

1. **未修改** `local-server/server.mjs`，所以还没有真实的 Broker 分区确认 HTTP API。
2. **未修改** `local-server/submission-service.mjs` / `bdzip.mjs`，
   `reviewed-keyin.json` 还不会自动进入当前 0.3 BDZIP；
   也没有升级导入器到新的 `0.4-reviewed-keyin` 协议。
3. **未修改**现有前端 Broker Review、Auditor Worksheet 页面。
4. **尚未把** PDF.js/activeParsedSources() 的真实提取结果全部映射到新 catalog；
   `createBrokerReview(..., {candidates, sourceFiles})` 接受显式已绑定候选，
   需下一段接入。尚无保险公司逐家字段覆盖认证。
5. 现有 Case 的 `documents` 是文件待办清单，`listDocuments()` 是原始文件记录；
   下一段必须将两者绑定，阻止缺原件或扫描不可读被判成完整确认。
6. `Remarks` 正文仍需 Broker 最终确认。自动模板不等于 UW 接受或报价资格判断。
7. 此阶段模块未连接生产路由，不会在应用启动时自动迁移 SQLite。

## Windows 安装测试

先备份工作目录并确保你的 Git 工作区无未提交重要修改。
PowerShell 进入项目根目录后：

```powershell
git switch feature/broker-auditor-lan-pilot
git switch -c feature/broker-keyin-step1

# ZIP 用你的真实路径替换，解压到项目根目录
Expand-Archive -LiteralPath "C:\Downloads\brokerdesk-step1-core-review.zip" -DestinationPath . -Force

node --version
node --test tests/broker-keyin-review.test.mjs tests/remarks-generator.test.mjs tests/reviewed-keyin-package.test.mjs
git status --short
```

`node` 使用 v22.13 或更高版本（项目 `package.json` 要求）。
`node:sqlite` 可能打印 ExperimentalWarning，这是 Node 22 预期提醒。

正确结果：32 tests, 32 pass, 0 fail。
**不要**把“单元测试全绿”当成跨项目 UI、Windows CI 或生产的最终验收。

如果你还要检查已有项目：

```powershell
npm run lint
npm run build
```

这两项需要已有项目完整依赖环境；该 ZIP 作者没有获得整仓的本地副本，
因此无法在本环境替你验证。

## 使用说明：可在纯 Node 里调用的模块

```js
import { generateRemarks } from "./lib/remarks-generator.mjs";
import {
  createBrokerReview, confirmBrokerReviewSection,
  editBrokerReviewField, finalizeBrokerReview
} from "./lib/broker-keyin-review.mjs";
```

`createBrokerReview(caseData, options)` 的 `caseData` 使用已有
`InsuranceCase` JSON 形状。
`options` 的主要字段：

- `sourceFiles`: `[{id, sha256}]`，必须来自本机校验过的原始文件；
- `candidates`: `[{fieldId,value,documentId,sourceHash,page,active:true}]`，
  只有显式 fieldId、活动文件且哈希一致才自动关联；
- `driverAssignmentsByVehicle`: `{ [vehicleId]: [{driverId,role}] }`；
- `garagingSameMailByVehicle`: `{ [vehicleId]: boolean }`；
- `commuteByVehicle`: `{ [vehicleId]: boolean }`；
- `coverageByVehicle`: `{ [vehicleId]: {liability,allPerils,collision,
  comprehensive,opcf,opcf44} }`；
- `quoteDiscounts`: 当前 Quote 中实际列出的折扣，而不是所有潜在折扣；
- `reports`: `[{type:"mvr"|"dash",id,pulledDate,summary}]`；
- `remarksText`: policy change 已核对的纯文本 Remarks。

调用 `confirmBrokerReviewSection()` 时附 `actor`,`expectedRevision`,`referenceDate`。
最后 `finalizeBrokerReview()` 会重检每个分区的确认哈希和报告有效期。

`BrokerKeyinReviewStore` 只在具有真实 `cases` / `audit_events` 表的
**本地服务端**使用，不要在浏览器客户端建立 SQLite 写权限。

## 重要设计边界

- 30 天报告年龄只在超过 30 天/日期无效时拦截；
  UI 以后只显示 Pulled Date，默认不展示“剩余天数”。
- 驾驶员在 Vehicle 下按 `Driver -> Role` 排列，仅显示实际分配角色，
  `PRINCIPAL`、`SECONDARY`、`OCCASIONAL`、`NOT_INCLUDED_IN_RATING`、`EXCLUDED`
  都是显式枚举值，不能自动猜测。
- 未成功读取的 Claims/Convictions ≠ `No`。
- Quote 未明确的 Coverage 不能自动当成 No。
- `reviewed-keyin.json` 的 SHA-256 用于一致性检测，不是密码学签字。
- 不要让 Auditor 再逐字段确认：下一阶段 UI 对 Auditor 应该是可复制工作表，
  只在异常时允许修改并另记 Audit Override。

## 下一段建议

Step 2：在真正的本地仓库上串接 `server.mjs` API、数据库初始化、
Broker Review 页面和实时 Case/Document 同步（先测 Windows UI）。
Step 3：升级 BDZIP Export/Import 到 0.4、ID 重映射、Auditor Sheet 和
新旧包兼容策略；完成后运行完整 CI / E2E / 私有真实样本复测。

## GitHub 纳入时的安全检查补充

- 修正 OPCF 44 / 44R 选项为明确的 Yes/No 均有效，不得把未选 OPCF 44 判作缺件。
- Auditor 预览未完成 Review 时显示 `DRAFT`，不得伪称 `BROKER_CONFIRMED`。
- 拦截 Reviewed Package 中重复来源 ID；被保人姓名仅在比较时按 token/标点顺序归一，原文不改。
- 与现有 `main` / Pilot v0.3 导出或 HTTP 路由**仍未联通**；新增模块可单独 CI 验收，不会改变现有 Broker/Auditor UI。
