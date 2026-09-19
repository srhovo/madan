#!/usr/bin/env node
/**
 * 用 GitHub Git Data API 推送本地提交（绕过 git-over-HTTPS 的 TLS 故障）。
 *
 * 适用场景：本机 `git push` 报
 *   gnutls_handshake() failed: The TLS connection was non-properly terminated
 * 而 `curl`/`gh api` 访问 api.github.com 正常。
 * 这条路走的是 api.github.com（HTTPS REST），与 git 的传输协议不同，能绕开。
 *
 * 做法（等价于 git push，但由我们自己拼对象）：
 *   1. 取远端 main 的当前 head 作为 base
 *   2. 把 origin/main..HEAD 之间每个提交的 tree 与 blob 全部上传
 *      （已存在的对象 GitHub 会返回 409，按「已存在」处理即可）
 *   3. 逐个建 commit 对象，串成链
 *   4. 把 main 引用移到最后一个 commit
 *
 * 用法：GH_TOKEN=xxx node tools/gh-api-push.js <owner/repo> <branch>
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.argv[2];
const BRANCH = process.argv[3] || 'main';
const TOKEN = process.env.GH_TOKEN;
if (!REPO || !TOKEN) { console.error('用法：GH_TOKEN=xxx node tools/gh-api-push.js <owner/repo> [branch]'); process.exit(1); }

const ROOT = path.join(__dirname, '..');
const API = `https://api.github.com/repos/${REPO}`;

const sh = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

async function api(method, url, body) {
  // 【8.3.47】带退避重试。GitHub 对「短时间大量写入」有二次限流（403 secondary rate limit），
  // 一次发版要传几十个对象，撞上就会把整条推送打断在半路（前面已建的对象全成孤儿）。
  // 遇到 403/429 就等一会儿再试，最多 5 次，指数退避。
  const MAX_TRY = 5;
  for (let attempt = 1; attempt <= MAX_TRY; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'madan-release',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
    const rateLimited = res.status === 403 || res.status === 429;
    if (rateLimited && attempt < MAX_TRY) {
      // 优先听 GitHub 给的 Retry-After，没给就指数退避
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const waitMs = retryAfter ? retryAfter * 1000 : Math.min(60000, 2000 * 2 ** (attempt - 1));
      console.log(`  · 被限流（${res.status}），等 ${Math.round(waitMs / 1000)}s 后重试（第 ${attempt}/${MAX_TRY - 1} 次）`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return { status: res.status, json, text };
  }
  throw new Error('重试次数用尽');
}

/* 上传一个 blob，返回 sha。409 = 已存在（内容哈希相同），直接复用。
   内容**从 git 对象里读**（`git cat-file`），不从工作区文件读 ——
   工作区只反映 HEAD 那一刻的状态，而中间某个提交里的文件
   （例如随后被删掉的临时说明文件）在工作区里已经不存在了，
   直接读文件会 ENOENT，整条推送断在中间。 */
async function putBlob(blobSha, filePath) {
  const content = execSync(`git cat-file blob ${blobSha}`, { cwd: ROOT, maxBuffer: 1 << 28 }).toString('base64');
  const r = await api('POST', `${API}/git/blobs`, { content, encoding: 'base64' });
  if (r.status === 201 || r.status === 200) return r.json.sha;
  if (r.status === 409) return blobSha; // 远端已有同样内容的对象
  throw new Error(`上传 blob 失败（${filePath}）：${r.status} ${r.text.slice(0, 200)}`);
}

/* 把一批 blob 并发上传（顺序不限，互不依赖）。
   为什么不用「先 GET 探测远端有没有」那套：每个文件都要多一个来回，
   而本仓库单次发版要传几十个文件、其中还有 380KB 的更新包 ——
   串行 + 逐个探测会把推送拖到分钟级，容易在中间被时限掐断（实测踩过：
   传到第 4 个提交就被 terminated，前面已建的对象全成了孤儿）。
   改成「直接排队上传 + 并发」，已存在的内容 GitHub 返回 409，按命中处理。 */
async function putBlobs(jobs) {
  const out = new Map();
  // 并发别开太大：GitHub 的二次限流是按「短时间请求数」算的，
  // 8 路并发很容易吃 403（实测踩过）。3 路 + 遇限流自动退避更稳。
  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const sha = await putBlob(job.sha, job.path);
      out.set(job.path, sha);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  return out;
}

/* 为一个提交上传全部文件并建 tree，返回 tree sha。 */
async function buildTree(treeish) {
  /* 【修·重要】读文件清单必须用 `-z`（NUL 分隔），**不能**用默认的按行输出。
     原因：git 对含非 ASCII 的文件名会做「C 语言式转义」——
     把路径用双引号括起来，中文逐字节写成八进制（例如
     `"memex/\344\270\213\346\254\241..."`）。
     按行读、再照字面拿去建树，这些引号和八进制串就会被当成
     **真实文件名**推上去，在仓库里凭空多出名为 `"memex`、`"tests`
     这样的垃圾目录（实测踩过：远端真的长出了两个带引号的目录，
     还把 version.json 挤掉了）。
     `-z` 用 NUL 分隔、路径原样输出，不经过任何转义，
     中文文件名也能安全通过。 */
  const listing = sh(`git ls-tree -r -z ${treeish}`).split('\0').filter(Boolean);
  const jobs = [];
  for (const line of listing) {
    const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t([\s\S]*)$/);
    if (!m) continue;
    const [, mode, type, sha, file] = m;
    if (type !== 'blob') continue;
    jobs.push({ path: file, mode, sha });
  }
  const uploaded = await putBlobs(jobs);
  const entries = jobs.map(j => ({
    path: j.path,
    mode: j.mode === '100755' ? '100755' : '100644',
    type: 'blob',
    sha: uploaded.get(j.path) || j.sha,
  }));
  // 大仓库要分批建 tree，这里一次性提交，必要时按 400 个一组
  const CHUNK = 400;
  if (entries.length <= CHUNK) {
    const r = await api('POST', `${API}/git/trees`, { tree: entries });
    if (r.status !== 201) throw new Error(`建 tree 失败：${r.status} ${r.text.slice(0, 300)}`);
    return r.json.sha;
  }
  let baseTree = null;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const part = entries.slice(i, i + CHUNK);
    const body = baseTree ? { base_tree: baseTree, tree: part } : { tree: part };
    const r = await api('POST', `${API}/git/trees`, body);
    if (r.status !== 201) throw new Error(`建 tree 失败（分批）：${r.status} ${r.text.slice(0, 300)}`);
    baseTree = r.json.sha;
  }
  return baseTree;
}

/* 把 ISO 时间串转成 git 要的「秒级时间戳 + 时区」格式。
   例如 2026-09-19T08:46:22Z → 1789807582 +0000

   【修·重要】时区必须固定写 `+0000`，**不能**按本机时区算。
   原先这里取的是 `-new Date().getTimezoneOffset()` —— 本机是东八区，
   于是算出 `+0800`。但 GitHub API 给出的时间戳是 UTC 的（带 Z 结尾），
   它那边记录的时区就是 `+0000`。两边差这一段，提交的字节就不一样，
   算出来的提交号自然也对不上（实测：本地算出的号与远端差一截，
   整个「把远端对象取回本地」的功能因此一直报错停下）。

   时间戳本身没算错（同一时刻的秒数在任何时区都一样），
   错的只是后面挂的那个时区标记 —— 所以这里只要把它钉死成 `+0000`，
   拼出来的字节就与远端逐字节一致，提交号也就对上了。 */
function toGitTime(iso) {
  const secs = Math.floor(new Date(iso).getTime() / 1000);
  return `${secs} +0000`;
}

(async () => {
  const localHead = sh('git rev-parse HEAD');
  const localBase = sh(`git rev-parse origin/${BRANCH}`);
  const remote = await api('GET', `${API}/git/ref/heads/${BRANCH}`);
  if (remote.status !== 200) throw new Error(`取远端分支失败：${remote.status}`);
  const remoteSha = remote.json.object.sha;

  console.log('本地 HEAD   :', localHead.slice(0, 7));
  console.log('本地 base   :', localBase.slice(0, 7));
  console.log('远端 head   :', remoteSha.slice(0, 7));

  /* 一致性核对。
     【8.3.47】注意这里允许一种正常情况：本地 origin/main 这个「引用」是**过期**的，
     而远端 head 其实**就是**我们上一次用本脚本推上去的那个提交 ——
     因为 API 建出来的提交对象不在本地库里，本地引用没法自动跟上，
     而 git fetch 又可能因 TLS 故障连不上。
     这种情况下继续推是安全的：我们要接的正是自己上一棒的尾巴。
     真正要拦住的是「远端出现了我们不认识的提交」——那才可能覆盖别人的工作。 */
  const remoteShaFull = remoteSha;

  /* 【修·重要】这里**不再**去「把远端对象取回本地」。
     原先的做法是：从 GitHub 把远端 head 的提交与它整棵树（含所有 blob）
     全部落到本地对象库，好在本地做比对、也好把它当父提交。
     这个做法三次尝试都没走通，原因是它本质上是在重新实现一遍 `git fetch` ——
     要按 git 的字节规则把每个目录对象重造出来，任何一处偏差都会让对象号对不上，
     而 GitHub 在服务端记时间的方式与我们换算出来的秒数差几小时，
     这段差异**永远对不上**（已实测：作者、提交人、说明三者逐字节一致，唯独时间戳不同）。
     而且这条路是多余的吗？也不是「取回来才能接续」——
     新提交的父只需要写远端那个号，**服务端自己认得**，本地不认得并不妨碍推送。

     所以改成：核对口径从「提交号是否相同」换成「**父链是否接得上本地**」，
     并且完全不需要把远端对象拉回本地 —— 沿远端的父链一路往回问 GitHub，
     只要在若干跳之内碰到一个**本地已认识**的提交，就说明
     「远端是在我们已知的历史上长出来的」，可以安全接续。
     这样既避免了重造对象的无穷麻烦，又保住了真正要防的事：
     「远端出现了一段与本地毫无关系的新历史」时必须拦住。

     为什么单看「根树是否在本地出现过」不够（实测踩过）：
     本脚本每次推送都会在远端留下新提交，而本地那个 origin/main 引用
     因为 git fetch 走不通、永远停在原地。于是「远端 head 的根树」
     在本地自然找不到 —— 可它明明是我们自己上一棒推上去的，
     会被误判成「别人推的」而拦住整条推送。改看父链之后，
     回溯两跳就碰到本地已知的 base，判定为「自己人」，放行。 */
  const remoteCommitRes = await api('GET', `${API}/git/commits/${remoteShaFull}`);
  const remoteRootTree = remoteCommitRes.status === 200 ? String(remoteCommitRes.json?.tree?.sha || '') : '';

  const knownRemotely = sh(`git rev-list --all --format=%H`).split('\n').includes(remoteShaFull);

  /* 沿远端父链往回走，看能否碰到本地已认识的提交。
     走到的那个提交就是**接续点**（新提交的父应当指向远端 head 本身，
     但能不能推，取决于这条链有没有接到我们已知的历史上）。
     限制跳数，避免异常情况下无限往回爬。 */
  let remoteBackToLocal = false;
  let walkSha = remoteShaFull;
  let walked = 0;
  const MAX_WALK = 30;
  while (walkSha && walked < MAX_WALK) {
    const isLocal = sh(`git cat-file -e ${walkSha}^{commit} 2>/dev/null && echo yes || echo no`) === 'yes';
    if (isLocal) { remoteBackToLocal = true; break; }
    const one = await api('GET', `${API}/git/commits/${walkSha}`);
    if (one.status !== 200) break;
    const parents = (one.json?.parents || []).map(p => p.sha);
    walkSha = parents[0] || '';
    walked++;
  }

  if (remoteShaFull !== localBase && !knownRemotely && !remoteBackToLocal) {
    console.error('\n✗ 远端 head 与本地历史接不上 ——');
    console.error('  沿远端父链往回走了 ' + walked + ' 跳，都没碰到本地认识的提交。');
    console.error('  说明远端有别人（或别的工具）新推的提交，直接推会覆盖它们。');
    console.error('  请先确认这些提交的来历，再决定是否继续。');
    console.error(`  （远端内容指纹 ${(remoteRootTree || '未知').slice(0, 7)}）`);
    process.exit(1);
  }
  if (remoteShaFull !== localBase) {
    console.log(knownRemotely
      ? '· 远端 head 是本地已知提交，按它作为接续点继续。'
      : `· 本地 origin/main 引用已过期（远端领先 ${walked} 跳），其父链接在本地已知历史上，按远端 head 作为接续点继续。`);
  }

  const commits = sh(`git rev-list --reverse origin/${BRANCH}..HEAD`).split('\n').filter(Boolean);
  console.log('待推送提交数:', commits.length);
  if (!commits.length) { console.log('没有需要推送的提交。'); return; }

  let parent = remoteSha;
  for (const sha of commits) {
    const msg = sh(`git log -1 --format=%B ${sha}`);
    // 注意：`%an <%ae>` 里的 `<` `>` 会被 shell 当成重定向，必须用分隔符取值后再拼。
    const authorName = sh(`git log -1 --format=%an ${sha}`);
    const authorEmail = sh(`git log -1 --format=%ae ${sha}`);
    const date = sh(`git log -1 --format=%aI ${sha}`);
    console.log(`\n· ${sha.slice(0, 7)} ${msg.split('\n')[0].slice(0, 60)}`);
    const tree = await buildTree(sha);
    console.log('  tree  ', tree.slice(0, 7));
    const r = await api('POST', `${API}/git/commits`, {
      message: msg.endsWith('\n') ? msg : msg + '\n',
      tree,
      parents: [parent],
      author: { name: authorName, email: authorEmail, date },
      committer: { name: authorName, email: authorEmail, date },
    });
    if (r.status !== 201) throw new Error(`建提交失败：${r.status} ${r.text.slice(0, 300)}`);
    parent = r.json.sha;
    console.log('  commit', parent.slice(0, 7));
  }

  console.log('\n把', BRANCH, '移到', parent.slice(0, 7));
  const upd = await api('PATCH', `${API}/git/refs/heads/${BRANCH}`, { sha: parent, force: false });
  if (upd.status !== 200) throw new Error(`更新分支失败：${upd.status} ${upd.text.slice(0, 300)}`);
  console.log('✓ 已推送。远端', BRANCH, '现在是', upd.json.object.sha.slice(0, 7));
})().catch(e => { console.error('\n✗ ' + e.message); process.exit(1); });
