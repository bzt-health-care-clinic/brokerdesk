# BrokerDesk Step 3C — VIN / Licence / Ownership / Signed Evidence 回归包

**适用基线：** Draft PR #3 的 `7989744f2408d107d9749c7dd9a6ffaa3e768034` 或未更改有关接口的后续提交。

**交付范围：只新增一个测试文件，不修改产品逻辑、数据库迁移、BDZIP 或现有浏览器界面。** 默认 v0.3 保持不变，v0.4 仍需开关启用。

## 测什么

这 10 项测试使用 BrokerDesk **实际的** `LocalRepositories`、临时 SQLite、本地文件保存与哈希、`projectBrokerReviewedCase()`、`authoritativeIntake()`：

1. 完整合成 Auto 基线的签字、被保人姓名和逐车 Ownership 证据有效。
2. Broker 只改 VIN、Ownership 仍旧时，新 VIN 不被旧 Ownership 放行。
3. Broker 确认并替换新的 Ownership 文件及其匹配资料时，新 VIN 能通过对应 Ownership 核验。
4. 内部 Driver ID 稳定时，Licence 修正只作用于该 Driver，原 Broker Case 不被暗改。
5. 姓名的顺序、逗号等标点差异不会误判为不一致。
6. 实质不同的被保人姓名不能继续复用原 Signed Application / Quote 的身份确认。
7. 原始 Signed Application 保存后如果字节发生变化，签字验证失效。
8. Ownership 原文件字节改变后不能继续作为有效凭证。
9. Ownership 的逻辑页段被撤回后不能作为有效凭证。
10. 新增第二辆车不能借用第一辆车的 Ownership。

所有输入都是 **SYNTHETIC**。测试为了专门验证打包前的证据校验链，将一段模拟字节以 `.pdf` 文件名保存在隔离目录，但**不是合法 PDF**、没有真实签名，也不测试 PDF.js 解析、OCR 或视觉识别。签字验证模拟人工已核对的 API 状态：它验证证据指向和字节完整性，不证明笔迹真实性。

## 安装

在 `feature/broker-auditor-lan-pilot` 最新提交上建立独立测试分支，把 ZIP 解压到仓库根目录。只会新增：

`tests/broker-step3c-identity-evidence.test.mjs`

文件头注释标明 Stage 3C，可随时删除回退。

## Windows 运行

须使用仓库 Pilot 要求的 **Node.js 24**。在 PowerShell 中运行：

```powershell
node -v
node --check tests/broker-step3c-identity-evidence.test.mjs
node --test tests/broker-step3c-identity-evidence.test.mjs
node --test tests/broker-reviewed-case-projection-step3b.test.mjs tests/broker-reviewed-case-compat-step3b.test.mjs
npx tsc --noEmit
npm run build
git diff --check
```

预期 Stage 3C：`tests 10`, `pass 10`, `fail 0`。这里的**预期**不是宣称已在你的 Windows 真实仓库上执行成功。

如 Stage 3C 失败，请复制失败测试的名称、AssertionError 和 Intake blocker code（不要上传客户文件）。优先查清是 API/模型变化，还是现行规则确实没有正确阻断。

## 验收范围

- 源码适配依据：`7989744` GitHub 代码（2026-10-22），不是本机完整仓库 Clone。
- 已在本环境做：Node 22 语法检查；Step 3B 隔离模块兼容测试 23/23。
- **未在本环境做**：Node 24 实仓执行 Stage 3C、Windows CI、Broker→BDZIP→Auditor 的 VIN/Licence 端到端、合法 PDF 解析或真实办公室双电脑。

此段作为 Gate 回归专项；全部通过后，下一段才做带真实 `.bdzip` 的 VIN/Licence 正负端到端测试，再安排客户隐私隔离的双机试点。

## 工作流

保持 PR #3 为 Draft，不合并 main、不修改现行本机程序。只有项目测试负责人核实此新增文件及其测试结果后，才考虑把测试命令加入 Windows CI。
