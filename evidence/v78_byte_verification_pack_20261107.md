# v78 独立字节核对包（固定提交 `381aab3` + 中文路径转义勘误）

> 用途：让对方**不运行我方任何脚本**、只用系统自带 `curl` / `wc` / `sha256sum` / `git` / PowerShell，就能独立取得至少一件工件的原始字节、长度与 SHA-256。
> 全部读数为我方本机实测，属**对方报告**；你方独立取得并比对后才算已核。我方不代核、不宣称复算通过、不宣称业务授权通过。
> 事故状态：OPEN / HOLD-NO-GO / M2 未签 / 阶段一 PASS 暂缓 / `TS_WRITE_FREEZE=1`。

---

## §1 固定提交与对象绑定（按 SHA 钉死，不受后续 push 影响）

| 项 | 值 |
|---|---|
| 固定提交 | `381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1`（v77 最终 main） |
| tree | `daf1b1e2d1bd130549bc7cda74d7b3ee153a78b6` |
| 本包「一件」 | `evidence/v77_live_state_20261107.json` |
| 该件 Git blob SHA-1 | `4e90d1aa6184d65b8cca7f0542bab6f1e1ef72bc` |
| 原始字节数 | **2360** |
| 原始字节 SHA-256 | `40108b9768ba2ab273b9ac9dfc426b88e3b9e43408d3eff86c15139fc5ee8dea` |
| 本机按 commit 取 raw | **HTTP 200 / 2360 B / 与本地逐字节一致**（对方报告） |

对象链复核（Git 自带，不需我方脚本）：

```
git cat-file -t 381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1        # commit
git cat-file -p 381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1        # 首行 tree 应为 daf1b1e...
git -c core.quotePath=false ls-tree -r 381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1 -- evidence/v77_live_state_20261107.json
# 期望：100644 blob 4e90d1aa6184d65b8cca7f0542bab6f1e1ef72bc	evidence/v77_live_state_20261107.json
git cat-file blob 4e90d1aa6184d65b8cca7f0542bab6f1e1ef72bc | wc -c     # 期望 2360
```

---

## §2 「一件 / 三步」零门槛路径

```
U=https://raw.githubusercontent.com/ritajin-tech/SMCN_ERP-T1B-audit-shared/381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1/evidence/v77_live_state_20261107.json
curl -sS -o v77_live_state.json "$U"
wc -c v77_live_state.json          # 期望 2360
sha256sum v77_live_state.json      # 期望 40108b9768ba2ab273b9ac9dfc426b88e3b9e43408d3eff86c15139fc5ee8dea
```

PowerShell 等价：

```powershell
$u = 'https://raw.githubusercontent.com/ritajin-tech/SMCN_ERP-T1B-audit-shared/381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1/evidence/v77_live_state_20261107.json'
Invoke-WebRequest -Uri $u -OutFile .\v77_live_state.json
(Get-Item .\v77_live_state.json).Length                    # 期望 2360
(Get-FileHash .\v77_live_state.json -Algorithm SHA256).Hash.ToLower()   # 期望 40108b97...
```

上一固定点 `9363638` 的同类命令仍有效（`evidence/v76_live_state_20261107.json` / 2031 B / `2cd458c8d294c50b654f4af80882ebf1580a3b9672cb5e89ec047745c5c8a57c`），见 `evidence/v77_byte_verification_pack_20261107.md`。

---

## §3 【本轮必读】中文路径转义勘误：为什么 `git ls-tree` 会少算 115 件

### 3.1 现象

Git 默认 `core.quotePath=true`。中文文件名在 `git ls-tree` 输出里会被转成八进制转义并加双引号，例如：

```
"docs/A1_404_\346\201\242\345\244\215\346\226\271\346\241\210_..."
```

因此 `grep -c '^docs/'` 只数得到纯 ASCII 路径，**中文文件全部漏计**；若据此与哈希清单比对，会误判「清单有 110 件文件不存在」。

### 3.2 同一提交的实测对照

| 命令 | `381aab3` 的 docs+evidence 计数 |
|---|---|
| `git ls-tree -r --name-only 381aab3 \| grep -cE '^(docs\|evidence)/'` | **222（错误）** |
| `git -c core.quotePath=false ls-tree -r --name-only 381aab3 \| grep -cE '^(docs\|evidence)/'` | **337（正确）** = docs 124 + evidence 213 |
| `git -c core.quotePath=false ls-tree -r --name-only 9363638 \| grep -cE '^(docs\|evidence)/'` | **332（正确）** |

### 3.3 结论与正确复核命令

- `evidence/v77_hash_inventory_20261107.json` 的 **332 件没有错**：以 `9363638` 的 tree 复算，路径集合**双向差集 0**，逐件字节数与 SHA-256 **差异 0**。
- `evidence/v78_hash_inventory_20261107.json` 为基准 `381aab3` 的 **337 件**逐件清单（不含 v78 新增件，避免自引用）。
- 差异根因是**显示层转义**，不是缺件、不是清单造假、不是提交不完整。

```
git -c core.quotePath=false ls-tree -r --name-only 93636382a7cc6f12f185dd77cb22744a3c79e042 | grep -E '^(docs|evidence)/' | wc -l   # 332
git -c core.quotePath=false ls-tree -r --name-only 381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1 | grep -E '^(docs|evidence)/' | wc -l   # 337
git -c core.quotePath=false ls-tree -r 93636382a7cc6f12f185dd77cb22744a3c79e042 -- "docs/T1-B_v75_明确方案与具体编辑_Tom可直接编辑_20261107.md"
```

逐件比对（系统自带工具）：

```
git -c core.quotePath=false ls-tree -r 93636382a7cc6f12f185dd77cb22744a3c79e042 -- docs evidence > tree.txt
git show 93636382a7cc6f12f185dd77cb22744a3c79e042:evidence/v76_live_state_20261107.json | sha256sum
```

> 本轮把该口径固化成 `tools/t1b_hash_inventory.py`（主项目仓库，非共享库）：内部用 `-c core.quotePath=false` 与 `-z` NUL 分隔解析，再逐件 `git cat-file blob` 取固定提交原始字节。**不要求你运行它**，上面几条 git 命令已足够独立复核。

---

## §4 修订溯源与「原件零改动」复核

> commit / tree / blob 均为 Git 对象标识（SHA-1）；文件原始字节 SHA-256 是另一算法，数值不应相等。

| 固定提交 | 文件 | blob SHA-1 | 字节 |
|---|---|---|---|
| `13bc6ec` | `docs/v75_full_review_20261107.md` | `93f2628e68962f99c982cacc00132fe751e4ae0d` | 20,934 |
| `13bc6ec` | `docs/T1-B_v75_明确方案与具体编辑_Tom可直接编辑_20261107.md` | `0d0e00dac486b032740a42dbd2eb2e419af70e3b` | 15,509 |
| `9363638` | `docs/v76_full_review_20261107.md` | `e9e627dda75810fd8119f289f1d72cb66692a94c` | 19,234 |
| `9363638` | `docs/T1-B_v76_明确方案与具体编辑_Tom可直接编辑_20261107.md` | `4030729dc42692a53edb610c44096c22bcc51236` | 15,249 |
| `9363638` | `evidence/v76_live_state_20261107.json` | `a91efd760f441dd6809faa4c405f46f0b0a08be7` | 2,031 |
| `381aab3` | `docs/v77_full_review_20261107.md` | `eaf5a9b93518e774893f4a4f080f0b016142bc96` | 18,437 |
| `381aab3` | `docs/T1-B_v77_明确方案与具体编辑_Tom可直接编辑_20261107.md` | `ccd8110c1a2a4e46d213bfe44848b8bee259aec3` | 18,921 |
| `381aab3` | `evidence/v77_live_state_20261107.json` | `4e90d1aa6184d65b8cca7f0542bab6f1e1ef72bc` | 2,360 |
| `381aab3` | `evidence/v77_hash_inventory_20261107.json` | `bc2caa21362a1e1a5ec828d7863ac7ffc077696a` | 79,327 |

零改动复核（同一路径在后续提交中 blob 不变即证明原件未被改写）：

```
git rev-parse 381aab3ef6d7bdbbf2d0f36bec0c6caf1e2b28d1:"docs/T1-B_v75_明确方案与具体编辑_Tom可直接编辑_20261107.md"
# 期望 0d0e00dac486b032740a42dbd2eb2e419af70e3b（与 13bc6ec 一致）
```

---

## §5 算法提示与状态边界

- `wc -c` 给的是**文件原始字节数**；`git cat-file -s <blob>` 给的是 Git 对象大小，两者对同一 blob 应相等。
- `git hash-object <file>` 给的是 **Git blob SHA-1**；`sha256sum <file>` 给的是**原始字节 SHA-256**；两者算法不同，不应相等。
- 本包不把任何材料标为「已核 / 复算通过 / 已确认」；本机 HTTP 200 与逐件比对均为**对方报告**，你方独立取得并比对后才算已核。
- 本包不要求运行 `recheck_v72.py` / `recheck_v73.py` / `t1b_hash_inventory.py` 或任何我方脚本。
- 本包不是验收结论、不是生产授权、不是解冻请求、不是 M2 签署材料。
- 红线：本轮零新部署、零链接变更、零生产写、零主库写、零改结构、零补列、零批量回灌、零解冻、零自动回滚。
