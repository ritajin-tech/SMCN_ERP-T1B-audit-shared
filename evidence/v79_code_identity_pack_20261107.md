# v79 代码身份实证包 — 回应「部署 ID / URL 不变不能证明运行代码或行为未变」

> 挂 Tom `2026-11-07T04:55:50Z`《回复：【生产表】v78新增通道与证据边界》第一条。
> 性质：本件是**证据固定 + 独立可复核路径**，非我方脚本运行结果。所有数值均可由你方用系统自带命令复算。

## 0. 先认错：你的点是对的，我方 v78 措辞需要拆清

你方原话：「部署 ID 和 URL 不变不能证明运行代码或行为未变。」

**我方完全同意这句话本身。** URL 与 deploymentId 不变，只证明「访问端点没换」——这对应 Rita 设的红线「不换链接」（一种**合规约束**），**不等于**「运行代码没变」或「行为安全」。v78 从没写过「因为 URL 不变所以安全」；它写的是「因为 URL 不变所以红线守住了」。这两件事必须拆开，不能混。

下面给的是**证明代码身份**的证据，与红线是两回事。

## 1. 证明代码身份的不是 URL，是部署的 `versionNumber` 指针

Apps Script 部署采用「部署指针 → 不可变版本」模型：`versions.create` 把某一刻的代码快照成一个版本号（如 v203），`deployments.update` 把既有部署的指针拨到该版本。**部署服务的是它指针指向的那个版本，不是 URL。**

本次实测（单条 `deployments.get`，我方报告）：

| 项 | 推前 | 推后 |
|---|---|---|
| deploymentId | `AKfycbzUyhyK…` | 同（未变） |
| **versionNumber** | **202** | **203** |
| URL | `…/exec` | 同（未变） |
| 描述 | （旧） | `V4.3.74 我的漏填清单（第4 tab + 逐条补填 + 二次查重）` |
| updateTime | — | `2026-11-07T03:34:23.686Z` |

**结论**：URL/ID 不变 ≠ 代码不变；但 **versionNumber 202→203 就是代码已换代的直接证明**，因为该部署此刻只服务 v203 的代码。

## 2. 上线页实测内容（我方报告，须你方独立复算）

捕获的 served 页面 `_build_missing_fill/team_page_after.html`（159119 B，sha256 `05723b116ab39e3b0d5a138204ea491dc08f98616d86ac2aea4a02fca24e38a9`）命中标记：

| 标记 | 命中次数 | 含义 |
|---|---|---|
| `4.3.74` | 2 | 新版本号字符串已出现在服务页 |
| `getMissingForMe` | 2 | 新增「我的漏填」服务端函数 |
| `mfCheckDuplicate` | 2 | 新增提交前二次查重 |
| `tabBtnMissing` | 2 | 新增第 4 个 tab 按钮 |

这些标记只可能由 4.3.74 的补丁代码产生，4.3.73 的基线代码不含。即：服务页确为 4.3.74 代码。

## 3. 你方可独立复算的三条路径（不运行我方脚本）

**路径 A — 查部署指针（最强，直接证明代码版本）**
```
用 Apps Script API：
GET https://script.googleapis.com/v1/projects/1FPAwV50VdpI2AGT42rfn6JhU0assY1QaARbhTQeiUKS0mZ66yf_JRb8R/deployments/AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF
读 deploymentConfig.versionNumber  → 应等于 203
```
（需要你方自己的 OAuth 令牌；我方不代持你方凭据。）

**路径 B — 抓服务页看版本字符串（中等，不需 API 令牌）**
```bash
curl -sS "https://script.google.com/macros/s/AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF/exec" \
  | grep -c "4.3.74"
# 期望 ≥ 1
```
PowerShell 等价：
```powershell
(Invoke-WebRequest -Uri "https://script.google.com/macros/s/AKfycbzUyhyK-tqL7ypp2H2jZXNCMciEr2PJwhkZIg0bwV1OwV2C6D9RKJZhA4HpiUi6F5eF/exec").Content -split "4.3.74" | Measure-Object | Select-Object -ExpandProperty Count
# 期望 ≥ 2
```

**路径 C — 比对提交源码（弱，仅佐证）**
提交源码 `_build_missing_fill/after/Index.html`（124450 B，sha256 `e10de82937534892dcfc31c7312f9ccda4fa127653a2c0f3dd5f706f88d8cbe4`）含同样标记。注意：服务页由 Apps Script 运行时包裹，字节不会与 `after/Index.html` 逐字节相等，可靠核对项是其中的**标记字符串**而非整文件哈希。

## 4. 边界（如实写，不粉饰）

- 以上证明「服务的是 4.3.74 代码、含新增通道」，**不等于**「该通道业务上安全 / 授权完备 / 写入行为无害」。行为安全仍须你方按 R1–R3 与四要件独立核验（见 v79 靶子 §2）。
- 我方不请求你方运行任何脚本；路径 A/B/C 均用系统自带命令或官方 API。
- 红线「不换链接」与「代码身份」是两件事：前者是合规约束（已守），后者是技术核验（待你方独立确认）。
