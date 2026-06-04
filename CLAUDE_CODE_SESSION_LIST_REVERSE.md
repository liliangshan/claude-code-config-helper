# Claude Code 官方扩展 会话列表机制逆向

> 逆向对象：`anthropic.claude-code-2.1.144-darwin-arm64/extension.js`（打包混淆后的官方 VS Code 扩展）
> 目的：搞清楚 "Past conversations / 历史会话(`/resume`)" 列表是怎么读取出来的，为在自有扩展中复刻提供参考。
> 文件大小约 2.1 MB，标识符已混淆，下文保留混淆名并标注其语义。

## 0. 结论速览

- 官方**没有**专门的 "list sessions" CLI 子命令；`claude -r` 是全屏 TUI，不向 stdout 输出结构化列表。
- 会话以 JSONL 持久化在 `<configDir>/projects/<projectKey>/<sessionId>.jsonl`。
- 列表功能直接**扫这些 `.jsonl` 文件**并提取元数据，核心优化是**只读文件头尾各 N 字节**，不解析整文件。
- 标题有多级兜底：`customTitle > aiTitle > lastPrompt > summary > firstPrompt`。
- 排除 sidechain（子代理）会话，合并 git worktree 会话，跨目录同 id 去重，按 mtime 倒序。

## 1. 存储路径与 projectKey 转义

会话文件路径：

```
<configDir>/projects/<projectKey>/<sessionId>.jsonl
```

### configDir 与 projects 根目录

```js
function YO(){ return path.join($M(), "projects"); }   // projects 根目录
```

- `$M()` = config 目录，默认 `~/.claude`，受环境变量 `CLAUDE_CONFIG_DIR` 影响。
- `YO()` 即 `<configDir>/projects`。

### projectKey 转义规则（函数 `TO`）

```js
const KO = 200;               // 长度上限
function TO(z){
  let V = z.replace(/[^a-zA-Z0-9]/g, "-");   // 所有“非字母数字”字符 → '-'
  if (V.length <= KO) return V;              // 未超长，直接用
  return `${V.slice(0, KO)}-${V_0(z)}`;      // 超长：截断 200 + '-' + 哈希后缀
}
function V_0(z){ return Math.abs(tR0(z)).toString(36); }  // 哈希取 base36
```

要点：
- 转义的是**所有非字母数字字符**（包括 `/`、`.`、`:` 等），不是只替换 `/`。
  例：`liliangshan-anthropic.claude-code` 目录中的 `.` 也被转成 `-`。
- 超过 200 字符的路径会被「前 200 字符 + `-` + base36 哈希」截断，避免文件名过长。

### 路径规整（函数 `qa`）

```js
async function qa(z){
  try { return (await fs.realpath(z)).normalize("NFC"); }  // 解符号链接
  catch { return z.normalize("NFC"); }                     // 失败则仅 NFC 规整
}
```

先解符号链接，再做 Unicode NFC 归一，保证不同写法的同一路径映射到同一 projectKey。

## 2. 调用链总览

```
listSessions()                          // 协议 handler（list_sessions_request）
  └─ Y40({dir, includeWorktrees})       // 入口分发
       ├─ sessionStore 存在 → Wf0       // 可插拔存储（claude.ai 镜像 / 远程等）
       └─ 否则           → k_0          // 默认文件系统实现 ★ 主路径
            ├─ y_0(dir, incWorktrees, needCount)  // 扫单项目(+worktree)目录
            │    ├─ rZ(dir)            // 收集匹配的 projects 子目录(主 + worktree 前缀)
            │    └─ lZ(dir, ...)       // 列目录里的 *.jsonl → {sessionId, filePath, mtime}
            ├─ Y_0(list)               // 不分页：全量 + 同 sessionId 去重(取最新)
            └─ T_0(list, limit, offset)// 分页：排序后按 32 个一批懒加载元数据
```

元数据真正提取：`wa` → `z_0`（读头尾字节）+ `Ga`（解析字段）。

### 入口分发 `Y40` / `k_0`

```js
function Y40(z){
  if (z?.sessionStore) return Wf0(z.sessionStore, z);  // 有外部存储走它
  return k_0(z);                                        // 否则走文件系统
}

async function k_0(z){
  let { dir, limit, offset, includeWorktrees } = z ?? {};
  let off = offset ?? 0;
  let paged = (limit !== undefined && limit > 0) || off > 0;  // 是否分页
  let raw = dir
    ? await y_0(dir, includeWorktrees ?? true, paged)   // 指定目录
    : await f_0(paged);                                  // 扫所有项目
  if (!paged) return Y_0(raw);        // 全量去重
  return T_0(raw, limit, off);        // 分页
}
```

## 3. 目录扫描

### 收集候选目录 `rZ`（含 worktree）

```js
async function rZ(z){
  let V = K_0(z), K = [];                      // K_0 = projects/<projectKey>
  try { await fs.readdir(V); K.push(V); } catch {}   // 主目录存在则加入
  let x = TO(z);
  if (x.length <= KO) return K;                // 未超长，无 worktree 前缀匹配
  let N = x.slice(0, KO) + "-";                // 超长场景：用前缀匹配兄弟目录
  let B = YO();
  for (let Z of await fs.readdir(B, {withFileTypes:true})) {
    if (!Z.isDirectory() || !Z.name.startsWith(N)) continue;
    let O = path.join(B, Z.name);
    if (O !== V) K.push(O);
  }
  return K;
}
```

### 列出单目录下的会话文件 `lZ`

```js
async function lZ(dir, needMtime, projectPath){
  let entries;
  try { entries = await fs.readdir(dir); } catch { return []; }
  return (await Promise.all(entries.map(async (name) => {
    if (!name.endsWith(".jsonl")) return null;
    let sid = NA(name.slice(0, -6));     // 去掉 .jsonl，并校验是合法 sessionId
    if (!sid) return null;
    let fp = path.join(dir, name);
    if (!needMtime) return { sessionId: sid, filePath: fp, mtime: 0, projectPath };
    try {
      let st = await fs.stat(fp);
      return { sessionId: sid, filePath: fp, mtime: st.mtime.getTime(), projectPath };
    } catch { return null; }
  }))).filter(Boolean);
}
```

- `NA(...)`：校验文件名主体是否为合法 sessionId（UUID 形态），非法则跳过。
- `needMtime=false` 时跳过 `stat`，仅在分页场景按需补 mtime，减少 IO。

### `y_0`：合并主目录 + worktree 目录

`y_0` 先对当前目录取 git worktree 列表（`Ua`）。无 worktree 时只扫 `rZ` 返回的目录；
有多个 worktree 时，按 projectKey 前缀去 `projects` 根目录里匹配并合并，同时用 `Set` 防止重复目录。

## 4. 元数据提取（性能关键）

### 只读头尾字节 `z_0`

```js
const j2 = 65536;     // 头尾各读 64KB
async function z_0(filePath){
  try {
    let fh = await fs.open(filePath, "r");
    try {
      let st = await fh.stat();
      let buf = Buffer.allocUnsafe(j2);
      let r1 = await fh.read(buf, 0, j2, 0);            // 读开头 j2 字节
      if (r1.bytesRead === 0) return null;
      let head = buf.toString("utf8", 0, r1.bytesRead);
      let tailStart = Math.max(0, st.size - j2);
      let tail = head;
      if (tailStart > 0) {                               // 文件较大时再读结尾 j2 字节
        let r2 = await fh.read(buf, 0, j2, tailStart);
        tail = buf.toString("utf8", 0, r2.bytesRead);
      }
      return { mtime: st.mtime.getTime(), size: st.size, head, tail };
    } finally { await fh.close(); }
  } catch { return null; }
}
```

要点：**绝不读整文件**。会话文件可达几十 MB（前面实测有 19MB 的），只读头尾两段即可拿到列表所需的全部字段。
- `head`：含首条用户消息、首个 timestamp、cwd、gitBranch。
- `tail`：含最新的标题/lastPrompt/summary/tag（这些是会话进行中追加写到文件末尾的）。

### 字段解析 `Ga`

```js
function Ga(sessionId, { head:x, tail:N, mtime:B, size:Z }, projectPath){
  // 1) 取第一行；若是 sidechain(子代理)会话 → 不进列表
  let firstLine = x.slice(0, x.indexOf("\n"));
  if (firstLine.includes('"isSidechain":true')) return null;

  // 2) 标题：customTitle(尾→头) → aiTitle(尾→头)
  let title = k7(N,"customTitle") || k7(x,"customTitle")
           || k7(N,"aiTitle")     || k7(x,"aiTitle") || undefined;

  // 3) firstPrompt：从 head 提取首条用户消息文本
  let firstPrompt = eR0(x) || undefined;

  // 4) createdAt：head 里第一个 timestamp
  let ts = oE(x, "timestamp");
  let createdAt = ts ? (Number.isNaN(Date.parse(ts)) ? undefined : Date.parse(ts)) : undefined;

  // 5) summary 兜底链：customTitle → lastPrompt(尾) → summary(尾) → firstPrompt
  let summary = title || k7(N,"lastPrompt") || k7(N,"summary") || firstPrompt;
  if (!summary) return null;             // 完全无可显示内容 → 丢弃

  // 6) 其它元数据
  let gitBranch = k7(N,"gitBranch") || oE(x,"gitBranch") || undefined;
  let cwd = oE(x,"cwd") || projectPath || undefined;
  let tagLine = N.split("\n").findLast(l => l.includes('"type":"tag"') && l.includes('"tag":"'));
  let tag = tagLine ? k7(tagLine, "tag") : undefined;

  return { sessionId, summary, lastModified: B, fileSize: Z,
           customTitle: title, firstPrompt, gitBranch, cwd, tag, createdAt };
}
```

辅助函数语义：
- `k7(text, field)`：从一段文本里抽取某 JSON 字段的值（轻量正则匹配，不做完整 JSON.parse）。
- `oE(text, field)`：类似 `k7`，用于 head 中的 timestamp / cwd / gitBranch。
- `eR0(head)`：解析首条 user 消息，得到 `firstPrompt`。
- `NA(name)`：校验 sessionId 合法性（UUID 形态）。

### 组装 `wa`

```js
async function wa(item){
  let raw = await z_0(item.filePath);
  if (!raw) return null;
  let info = Ga(item.sessionId, raw, item.projectPath);
  if (!info) return null;
  if (item.mtime) info.lastModified = item.mtime;   // 优先用 stat 的 mtime
  return info;
}
```

## 5. 排序 / 去重 / 分页

### 排序比较器 `b_0`

```js
function b_0(a, b){
  if (b.mtime !== a.mtime) return b.mtime - a.mtime;          // mtime 倒序
  return b.sessionId < a.sessionId ? -1                       // 同 mtime → sessionId 字典序
       : b.sessionId > a.sessionId ?  1 : 0;
}
```

### 全量去重 `Y_0`（不分页）

```js
async function Y_0(list){
  let infos = await Promise.all(list.map(wa));
  let map = new Map();
  for (let info of infos) {
    if (!info) continue;
    let prev = map.get(info.sessionId);
    if (!prev || info.lastModified > prev.lastModified)   // 同 id 取最新
      map.set(info.sessionId, info);
  }
  return [...map.values()].sort(/* 同 b_0：mtime 倒序，再 sessionId */);
}
```

### 分页 `T_0`（懒加载）

```js
const C_0 = 32;     // 每批数量
async function T_0(list, limit, offset){
  list.sort(b_0);                       // 先按 mtime 排（用的是廉价的 stat mtime）
  let out = [], cap = limit > 0 ? limit : Infinity, skipped = 0, seen = new Set();
  for (let i = 0; i < list.length && out.length < cap; ) {
    let batch = list.slice(i, Math.min(i + C_0, list.length));
    let infos = await Promise.all(batch.map(wa));   // 仅本批读头尾字节 + 解析
    for (let k = 0; k < infos.length && out.length < cap; k++) {
      i++;
      let info = infos[k];
      if (!info || seen.has(info.sessionId)) continue;
      seen.add(info.sessionId);
      if (skipped < offset) { skipped++; continue; }  // 跳过 offset
      out.push(info);
    }
  }
  return out;
}
```

分页核心优势：先用便宜的 `stat.mtime` 排序，再**只对需要的批次**调用 `wa`（读头尾+解析），凑够 `limit` 即停，避免对全部历史会话做 IO。

## 6. handler 层的额外处理

`listSessions()` 协议 handler 在 `Y40` 之上还做了：

```js
async listSessions(){
  let raw = await Y40({ dir: this.cwd, includeWorktrees: false });
  let teleport = await readTeleportMetadata(this.cwd, raw.map(s => s.sessionId));
  let sessions = raw.map(s => ({
    id: s.sessionId,
    lastModified: s.lastModified,
    fileSize: s.fileSize,
    summary: s.summary,
    gitBranch: s.gitBranch,
    worktree: nb(s.cwd),                       // worktree 显示名
    isCurrentWorkspace: sameDir(s.cwd, this.cwd),
    ...teleport.get(s.sessionId),              // 合并远程/teleport 元数据
  }));
  let hidden = new Set(this.settings.getHiddenSessionIds());
  return {
    type: "list_sessions_response",
    sessions: hidden.size > 0 ? sessions.filter(s => !hidden.has(s.id)) : sessions,
  };
}
```

额外点：
- `isCurrentWorkspace`：标记会话是否属于当前打开的工作区。
- `getHiddenSessionIds()`：用户手动隐藏的会话被过滤掉。
- `readTeleportMetadata` / `worktree`：合并远程镜像与 worktree 展示信息。

## 7. 会话 info 字段汇总

| 字段 | 来源 | 说明 |
|---|---|---|
| `sessionId` / `id` | 文件名去 `.jsonl` | 经 `NA` 校验为 UUID |
| `summary` | 多级兜底链 | `customTitle > aiTitle > lastPrompt > summary > firstPrompt` |
| `customTitle` | `k7(tail/head,"customTitle")` | 用户手动改的标题 |
| `firstPrompt` | `eR0(head)` | 首条用户消息 |
| `gitBranch` | `k7/oE(...,"gitBranch")` | 会话所在分支 |
| `cwd` | `oE(head,"cwd")` | 会话工作目录 |
| `tag` | tail 中最后一条 `type:"tag"` | 会话标签 |
| `createdAt` | head 第一个 `timestamp` | 创建时间 |
| `lastModified` | 文件 `stat.mtime` | 排序主键 |
| `fileSize` | 文件 `stat.size` | — |

## 8. 与朴素实现的差异（复刻 checklist）

| 维度 | 朴素脚本 | 官方做法 |
|---|---|---|
| 标题来源 | summary 或首条 user 消息 | 5 级兜底链 |
| 读取方式 | 逐行读全文件 | **只读头尾各 j2 字节** |
| 排序 | 文件 mtime | mtime，同值再按 sessionId |
| sidechain | 不处理 | 主动排除 `isSidechain:true` |
| worktree | 不处理 | 扫 `<key>-*` 兄弟目录合并 |
| 去重 | 无 | 跨目录同 id 取最新 |
| 分页 | 无 | 32 个一批懒加载元数据 |
| 隐藏会话 | 无 | `getHiddenSessionIds()` 过滤 |
| 路径转义 | 仅替换 `/` | 替换所有非字母数字，超长加哈希 |

## 9. 复刻建议（用于自有扩展）

1. **路径**：`path.join(configDir, "projects", TO(realpath(cwd)))`，`TO` 按"非字母数字→`-`、超 200 截断+哈希"。
2. **列目录**：读 `*.jsonl`，文件名校验 UUID。
3. **元数据**：用 `fs.open` + 头尾各读 64KB（官方 `j2 = 65536`），别读全文件。
4. **字段抽取**：对 head/tail 用轻量正则提字段，避免对超大行 `JSON.parse`。
5. **排序去重**：mtime 倒序 + 同 id 取最新。
6. **过滤**：排除 sidechain；如有隐藏机制再叠加。
7. **分页**：先 stat 排序，再分批读元数据。

## 附：关键混淆名对照表

| 混淆名 | 语义 |
|---|---|
| `$M()` | config 目录（`~/.claude` 或 `CLAUDE_CONFIG_DIR`） |
| `YO()` | `<config>/projects` 根目录 |
| `TO(p)` | path → projectKey 转义 |
| `K_0(p)` | `projects/<projectKey>` 完整路径 |
| `qa(p)` | realpath + NFC 规整 |
| `KO` | 长度上限常量 = 200 |
| `V_0(p)` | base36 哈希后缀 |
| `rZ(dir)` | 收集候选 project 目录（含 worktree 前缀） |
| `lZ(dir,...)` | 列目录内 `*.jsonl` |
| `y_0` / `f_0` | 扫单项目(+worktree) / 扫全部项目 |
| `k_0` | 默认文件系统 listSessions 实现 |
| `Y40` | 入口分发（sessionStore vs 文件系统） |
| `z_0(fp)` | 读文件头尾各 `j2` 字节 |
| `Ga(...)` | 从头尾文本解析会话 info |
| `wa(item)` | `z_0` + `Ga` 组装 |
| `b_0` | 排序比较器 |
| `Y_0` / `T_0` | 全量去重 / 分页 |
| `k7` / `oE` | 文本中抽取 JSON 字段值 |
| `eR0` | 提取首条 user 消息(firstPrompt) |
| `NA` | sessionId(UUID) 校验 |
| `j2` | 头尾读取字节数常量 = 65536（64KB） |
| `C_0` | 分页批大小 = 32 |





