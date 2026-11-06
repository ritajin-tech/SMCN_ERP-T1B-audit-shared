# T1-B v77 · 独立字节核对包（固定提交 → tree → blob → 原始字节 → 长度 / SHA-256）

> 建立：2026-11-07 01:28 北京｜挂 `docs/v77_full_review_20261107.md` §4.1
> 触发：Tom `msg_9u1zTyXk5ohEqEET0azTHCrFebh4pk42EzOsXHSXNQRnYg`（2026-11-06 17:24:33Z / 北京 11-07 01:24:33）原话：
> 「下一步先核对固定提交与至少一件工件的原始字节、长度及 SHA-256 …… 未独立取得的材料不标为已核，不运行所交脚本。」
> 性质：本件**只提供取得路径与登记值**，不是核验结论。我方不代你方核验、不把任何材料标为已核、不要求你方运行我方任何脚本。

---

## §1 最小路径：一件工件 / 三步 / 不运行我方脚本

**固定提交（按 SHA 取，不会被后续 push 改变）**：`93636382a7cc6f12f185dd77cb22744a3c79e042`
**该提交的 tree**：`80b8ff43d7af1c792217286c4027728f7b380ae9`
**最小样本工件**：`evidence/v76_live_state_20261107.json`（2,031 B，九件里最小）

### 路径 A · 直接取原始字节（推荐，一条 URL + 两条系统自带命令）

```
U=https://raw.githubusercontent.com/ritajin-tech/SMCN_ERP-T1B-audit-shared/93636382a7cc6f12f185dd77cb22744a3c79e042/evidence/v76_live_state_20261107.json
curl -sS -o v76_live_state.json "$U"
wc -c v76_live_state.json
sha256sum v76_live_state.json
```

PowerShell 等价（无需安装任何工具）：

```
Invoke-WebRequest -Uri $U -OutFile v76_live_state.json
(Get-Item v76_live_state.json).Length
(Get-FileHash v76_live_state.json -Algorithm SHA256).Hash.ToLower()
```

**期望输出**（登记值，非核验结论）：

| 项 | 登记值 |
|---|---|
| 长度（`wc -c`） | `2031` |
| 原始字节 SHA-256 | `2cd458c8d294c50b654f4af80882ebf1580a3b9672cb5e89ec047745c5c8a57c` |
| Git blob SHA-1 | `a91efd760f441dd6809faa4c405f46f0b0a08be7` |

> 用 `.../main/...` 取同一路径同样可用；但**按 commit SHA 取**才是「固定提交」的核对，因为 `main` 会随后续发布前移。两种写法我方本机均实测 `HTTP 200 / 2031 B / SHA-256` 一致 —— 这仍是我方报告，你方独立取得才算已核。

### 路径 B · 走 Git 对象链（commit → tree → blob → 字节）

```
git cat-file -p 93636382a7cc6f12f185dd77cb22744a3c79e042^{tree}
git ls-tree 93636382a7cc6f12f185dd77cb22744a3c79e042 evidence/v76_live_state_20261107.json
git cat-file blob a91efd760f441dd6809faa4c405f46f0b0a08be7 | sha256sum
```

`git ls-tree` 应给出 `100644 blob a91efd760f441dd6809faa4c405f46f0b0a08be7  evidence/v76_live_state_20261107.json`；第三条应得到与路径 A 相同的 SHA-256。

### 精度提示（避免假性不一致）

- 必须对**原始字节**计算，不要从浏览器渲染页复制文本另存；换行 CRLF/LF、BOM、尾随空格任一变化都会改变 SHA-256。
- `wc -c` 是字节数，不是字符数；中文文件名在 URL 中按 RFC 3986 percent-encode（§3 已给全）。
- `commit` / `tree` / `blob` 是 **Git 对象标识（SHA-1）**，文件列的是**原始字节 SHA-256**，算法不同，数值不应相等。

---

## §2 固定提交与 tree 的绑定实证（本机只读输出）

```
$ git rev-parse 9363638^{tree}
80b8ff43d7af1c792217286c4027728f7b380ae9

$ git ls-tree 9363638 <五件 v76 工件>（节选）
100644 blob e9e627dda75810fd8119f289f1d72cb66692a94c  docs/v76_full_review_20261107.md
100644 blob 4030729dc42692a53edb610c44096c22bcc51236  docs/T1-B_v76_明确方案与具体编辑_Tom可直接编辑_20261107.md
100644 blob a7fc4386295652f2c55803a495906d38124f2b3e  evidence/v76_fixed_versions_hashes_20261107.md
100644 blob 77dcae8eb4a10d321c08cb0c1c2a4d5917c4154c  evidence/v76_hash_inventory_20261107.json
100644 blob a91efd760f441dd6809faa4c405f46f0b0a08be7  evidence/v76_live_state_20261107.json
```

---

## §3 九件工件逐件固定（v75 四件 + v76 五件；基准提交 `9363638`）

| 文件 | 字节 | 原始字节 SHA-256 | Git blob SHA-1 |
|---|---:|---|---|
| `docs/v75_full_review_20261107.md` | 20,934 | `a2817e224cb285ded3fa590e3435b5e3992a25b7183d3dbb4aa9595fa6c21aea` | `93f2628e68962f99c982cacc00132fe751e4ae0d` |
| `docs/T1-B_v75_明确方案与具体编辑_Tom可直接编辑_20261107.md` | 15,509 | `6ecdbf4ca0f4fb82b62877c45f8261a3f3afa95814982b89ef9f63500572625a` | `0d0e00dac486b032740a42dbd2eb2e419af70e3b` |
| `evidence/v75_fixed_versions_hashes_20261107.md` | 9,369 | `7421b206858ba1761413c61f8379fc5c1f654117d3b8d4e30d30babee4b45903` | `65c42d73dc8f00e6eb93013306ec498418624131` |
| `evidence/v75_live_state_20261107.json` | 1,516 | `9370257e02036c7a2bc00e8ffad7b98e5a8cf4ff68f86966843d202b306e6053` | `a1997d87b9a2360c9956281ad25e740d516f2eea` |
| `docs/v76_full_review_20261107.md` | 19,234 | `42a17bb449900c9fa9d9445665908a48fb259452a05d9600e84aca4a40877af7` | `e9e627dda75810fd8119f289f1d72cb66692a94c` |
| `docs/T1-B_v76_明确方案与具体编辑_Tom可直接编辑_20261107.md` | 15,249 | `0c18903a4b1d79a9b67a9da71b565831a475e1c171d48455de46441c70e96315` | `4030729dc42692a53edb610c44096c22bcc51236` |
| `evidence/v76_fixed_versions_hashes_20261107.md` | 8,184 | `f922b94e233b05ce2786a7bafd2d2abaf5ece4f0c9794753194a4ce36cdb76be` | `a7fc4386295652f2c55803a495906d38124f2b3e` |
| `evidence/v76_hash_inventory_20261107.json` | 78,102 | `19752709d492f416932a1068b5f6eac832efd1f3be916641813ec1c0280f620e` | `77dcae8eb4a10d321c08cb0c1c2a4d5917c4154c` |
| `evidence/v76_live_state_20261107.json` | 2,031 | `2cd458c8d294c50b654f4af80882ebf1580a3b9672cb5e89ec047745c5c8a57c` | `a91efd760f441dd6809faa4c405f46f0b0a08be7` |

按 commit SHA 取原始字节的 URL 前缀（中文路径已 percent-encode，直接拼在后面即可）：

```
https://raw.githubusercontent.com/ritajin-tech/SMCN_ERP-T1B-audit-shared/93636382a7cc6f12f185dd77cb22744a3c79e042/
```

```
docs/v75_full_review_20261107.md
docs/T1-B_v75_%E6%98%8E%E7%A1%AE%E6%96%B9%E6%A1%88%E4%B8%8E%E5%85%B7%E4%BD%93%E7%BC%96%E8%BE%91_Tom%E5%8F%AF%E7%9B%B4%E6%8E%A5%E7%BC%96%E8%BE%91_20261107.md
evidence/v75_fixed_versions_hashes_20261107.md
evidence/v75_live_state_20261107.json
docs/v76_full_review_20261107.md
docs/T1-B_v76_%E6%98%8E%E7%A1%AE%E6%96%B9%E6%A1%88%E4%B8%8E%E5%85%B7%E4%BD%93%E7%BC%96%E8%BE%91_Tom%E5%8F%AF%E7%9B%B4%E6%8E%A5%E7%BC%96%E8%BE%91_20261107.md
evidence/v76_fixed_versions_hashes_20261107.md
evidence/v76_hash_inventory_20261107.json
evidence/v76_live_state_20261107.json
```

---

## §4 全量基准哈希清单

`evidence/v77_hash_inventory_20261107.json` —— 以 **v76 固定提交 `9363638`** 为基准的全部 **332 件** `docs/` + `evidence/` 文件（= v75 固定点 327 件 + v76 新增 5 件；**不含本轮 v77 新增 5 件，避免自引用**），逐件 `bytes` + 原始字节 SHA-256 + Git blob SHA-1。任选一件比对即可，不必全量、不必运行我方脚本、不必我方在场。

---

## §5 诚实边界（照单接受你方立场）

1. 上表所有数值、HTTP 200 实测、tree/blob 绑定，**均为对方报告**；你方未独立取得原始字节前，我方不标为已核、不宣称复算通过、不宣称业务授权通过。
2. 本件**不替代**「行数、漂移归因、部署状态、权限边界」的原始证据；那些仍分别为你方待核项，见 `docs/T1-B_v77_明确方案与具体编辑_Tom可直接编辑_20261107.md` §2 / §3。
3. **v75、v76 全部原件一个字节未改**，否则「固定」失去可核性；v77 是新增承接版，可逐行 diff。
4. 本件不要求、也不建议运行 `recheck_v72.py` / `recheck_v73.py` 或任何我方脚本；curl / sha256sum / git / PowerShell 均为系统自带工具。
5. 事故状态：OPEN / HOLD-NO-GO / M2 未签 / 阶段一 PASS 暂缓 / `TS_WRITE_FREEZE=1`，原样维持。本件不构成验收、不构成生产授权、不构成解冻请求。
6. 红线：零部署、零链接变更、零生产写、零主库写、零改结构、零补列、零解冻、零自动回滚。
