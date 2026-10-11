'use strict'

// 읽기 전용. chrome.bookmarks 의 create/move/update/remove 는 이 파일 어디에도 없다.

const ROOT_ID = chrome.bookmarks.ROOT_NODE_ID ?? '0'
const SECRET_RE = /[?#].*\b(token|session|sid|sig|key|jwt|access_token|id_token|refresh_token|code|passwd|password|secret|api_key)=/i
const PRIVATE_HOST_RE = /^(https?:\/\/)?(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1\d\d|2[0-4]\d|25[0-5])\.)/i

let LAST = null

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

function walk(node, path, acc) {
  // path: 이 노드의 조상 title 배열 (영구 루트부터)
  if (node.url !== undefined) {
    acc.urls.push({
      id: node.id,
      url: node.url,
      title: node.title ?? '',
      path: path.join('/'),
      dateAdded: node.dateAdded ?? null,
      dateLastUsed: node.dateLastUsed ?? null,
      unmodifiable: node.unmodifiable ?? null,
    })
    return
  }
  const here = path.concat(node.title ?? '')
  acc.folders.push({
    id: node.id,
    title: node.title ?? '',
    path: here.join('/'),
    parentPath: path.join('/'),
    depth: here.length,
    childCount: (node.children || []).length,
    unmodifiable: node.unmodifiable ?? null,
  })
  acc.maxDepth = Math.max(acc.maxDepth, here.length)
  for (const c of node.children || []) walk(c, here, acc)
}

async function measure() {
  const rootChildren = await chrome.bookmarks.getChildren(ROOT_ID)

  // 각 영구 루트를 개별적으로 훑어 루트별 집계를 낸다
  const roots = []
  for (const r of rootChildren) {
    const [sub] = await chrome.bookmarks.getSubTree(r.id)
    const acc = { urls: [], folders: [], maxDepth: 0 }
    for (const c of sub.children || []) walk(c, [r.title ?? r.id], acc)
    roots.push({
      id: r.id,
      title: r.title ?? '',
      folderType: r.folderType ?? null,
      syncing: r.syncing ?? null,
      unmodifiable: r.unmodifiable ?? null,
      directChildren: (sub.children || []).length,
      urlCount: acc.urls.length,
      folderCount: acc.folders.length,
      maxDepth: acc.maxDepth,
      topLevel: (sub.children || []).map((c) => (c.url === undefined ? (c.title ?? '') + '/' : c.title ?? '')),
      _urls: acc.urls,
      _folders: acc.folders,
    })
  }

  const allUrls = roots.flatMap((r) => r._urls)
  const allFolders = roots.flatMap((r) => r._folders)

  // 중복 URL (같은 URL 이 여러 위치에)
  const byUrl = new Map()
  for (const u of allUrls) {
    if (!byUrl.has(u.url)) byUrl.set(u.url, [])
    byUrl.get(u.url).push(u)
  }
  const dupes = [...byUrl.entries()].filter(([, v]) => v.length > 1)
    .map(([url, v]) => ({ url, count: v.length, paths: v.map((x) => x.path) }))

  // 동일 부모 안에 같은 이름의 형제 폴더 (머지 시 greedy 페어링이 깨지는 지점)
  const siblingKey = new Map()
  for (const f of allFolders) {
    const k = f.parentPath + '\u0000' + f.title
    siblingKey.set(k, (siblingKey.get(k) || 0) + 1)
  }
  const dupeFolders = [...siblingKey.entries()].filter(([, n]) => n > 1)
    .map(([k, n]) => ({ parent: k.split('\u0000')[0], title: k.split('\u0000')[1], count: n }))

  // 위험 URL
  const secrets = allUrls.filter((u) => SECRET_RE.test(u.url))
  const schemes = allUrls.filter((u) => /^(javascript|data|file|chrome|chrome-extension):/i.test(u.url))
  const privateHosts = allUrls.filter((u) => PRIVATE_HOST_RE.test(u.url))
  const managed = [...allUrls, ...allFolders].filter((n) => n.unmodifiable === 'managed')

  // 영구 루트 분류
  const byType = {}
  for (const r of roots) {
    const k = (r.folderType ?? 'unknown') + '/' + (r.syncing === true ? 'account' : r.syncing === false ? 'local' : 'unknown')
    byType[k] = (byType[k] || 0) + 1
  }
  const localWritable = roots.filter((r) => r.syncing === false && r.folderType !== 'managed')
  const accountRoots = roots.filter((r) => r.syncing === true)

  return {
    meta: {
      measuredAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      rootNodeIdConstant: chrome.bookmarks.ROOT_NODE_ID ?? null,
      rootIdUsed: ROOT_ID,
      extensionId: chrome.runtime.id,
    },
    roots: roots.map(({ _urls, _folders, ...r }) => r),
    byType,
    totals: {
      rootChildren: roots.length,
      urlEntries: allUrls.length,
      uniqueUrls: byUrl.size,
      folders: allFolders.length,
      maxDepth: Math.max(0, ...roots.map((r) => r.maxDepth)),
    },
    findings: {
      duplicateUrls: dupes,
      duplicateSiblingFolders: dupeFolders,
      secretsInQuery: secrets.map((u) => ({ path: u.path, title: u.title, url: u.url })),
      unusualSchemes: schemes.map((u) => ({ path: u.path, title: u.title, url: u.url })),
      privateHosts: privateHosts.map((u) => ({ path: u.path, title: u.title, url: u.url })),
      managedNodes: managed.length,
    },
    verdicts: {
      localRootsVisibleToApi: localWritable.length > 0,
      localWritableRoots: localWritable.map((r) => ({ id: r.id, title: r.title, folderType: r.folderType })),
      accountRootCount: accountRoots.length,
      duplicateFolderTypes: Object.entries(
        roots.reduce((m, r) => ((m[r.folderType ?? 'unknown'] = (m[r.folderType ?? 'unknown'] || 0) + 1), m), {})
      ).filter(([, n]) => n > 1).map(([t, n]) => ({ folderType: t, count: n })),
    },
    // 프로필 간 비교용 기준선 (파일 파싱 대체). 정렬해서 두 프로필 JSON 을 그대로 diff 할 수 있게 한다.
    baseline: {
      urls: allUrls.map((u) => ({ path: u.path, url: u.url, title: u.title }))
        .sort((a, b) => (a.url + a.path).localeCompare(b.url + b.path)),
      folders: allFolders.map((f) => f.path).sort((a, b) => a.localeCompare(b)),
    },
  }
}

function render(d) {
  const v = d.verdicts
  const f = d.findings
  const rows = d.roots.map((r) => `<tr>
      <td><code>${esc(r.id)}</code></td>
      <td>${esc(r.title) || '<span class="pill">제목없음</span>'}</td>
      <td><code>${esc(r.folderType ?? '—')}</code></td>
      <td>${r.syncing === true ? '<span class="bad">true (계정)</span>' : r.syncing === false ? '<span class="ok">false (로컬)</span>' : '—'}</td>
      <td class="num">${r.directChildren}</td>
      <td class="num">${r.urlCount}</td>
      <td class="num">${r.folderCount}</td>
    </tr>`).join('')

  const listOrNone = (arr, fmt) =>
    arr.length === 0 ? '<p class="sub">없음</p>' : '<pre>' + arr.map(fmt).map(esc).join('\n') + '</pre>'

  document.getElementById('ctx').innerHTML =
    `Chrome <code>${esc((d.meta.userAgent.match(/Chrome\/([\d.]+)/) || [, '?'])[1])}</code> · ` +
    `<code>ROOT_NODE_ID</code> ${d.meta.rootNodeIdConstant ? '제공됨 (<code>' + esc(d.meta.rootNodeIdConstant) + '</code>)' : '<span class="warn">미제공 → "0" 폴백 사용</span>'} · ` +
    `측정 ${esc(d.meta.measuredAt)}`

  document.getElementById('out').innerHTML = `
    <h2>핵심 판정</h2>
    <table>
      <tr><th style="width:52%">확장 API 가 쓰기 가능한 <b>로컬</b> 영구 폴더를 보는가</th>
          <td class="verdict ${v.localRootsVisibleToApi ? 'ok' : 'bad'}">
            ${v.localRootsVisibleToApi
              ? '예 — ' + v.localWritableRoots.map((r) => esc(r.folderType) + '(id ' + esc(r.id) + ')').join(', ')
              : '아니오 — syncing:false 루트가 트리에 없음 (부트스트랩 필요)'}
          </td></tr>
      <tr><th>계정(syncing:true) 영구 루트 수</th><td class="verdict">${v.accountRootCount}</td></tr>
      <tr><th>같은 folderType 이 중복 노출되는가</th>
          <td class="verdict ${v.duplicateFolderTypes.length ? 'warn' : ''}">
            ${v.duplicateFolderTypes.length
              ? v.duplicateFolderTypes.map((x) => esc(x.folderType) + ' ×' + x.count).join(', ')
              : '아니오 (각 1개씩)'}
          </td></tr>
      <tr><th>managed / unmodifiable 노드</th>
          <td class="verdict ${f.managedNodes ? 'warn' : ''}">${f.managedNodes}개 ${f.managedNodes ? '— 쓰기 대상에서 제외할 것' : ''}</td></tr>
    </table>

    <h2>루트의 자식 (<code>getChildren("${esc(d.meta.rootIdUsed)}")</code>)</h2>
    <table>
      <tr><th>id</th><th>title</th><th>folderType</th><th>syncing</th><th class="num">직계</th><th class="num">URL</th><th class="num">폴더</th></tr>
      ${rows}
    </table>
    <p class="sub"><code>syncing</code> 은 <b>영구 노드에서만</b> 정확합니다 (Chromium <code>bookmarks_api.cc</code> 주석: 비영구 노드에는 정확히 채워지지 않음).</p>

    <h2>집계</h2>
    <table>
      <tr><th>URL 항목 수</th><td class="num">${d.totals.urlEntries}</td></tr>
      <tr><th>고유 URL 수</th><td class="num">${d.totals.uniqueUrls}</td></tr>
      <tr><th>폴더 수 (영구 루트 제외)</th><td class="num">${d.totals.folders}</td></tr>
      <tr><th>최대 깊이</th><td class="num">${d.totals.maxDepth}</td></tr>
    </table>

    <h2>중복 URL <span class="pill">${f.duplicateUrls.length}</span></h2>
    ${listOrNone(f.duplicateUrls, (x) => `×${x.count}  ${x.url}\n        ${x.paths.join('\n        ')}`)}

    <h2>같은 부모 안 동명 폴더 <span class="pill">${f.duplicateSiblingFolders.length}</span></h2>
    <p class="sub">머지 시 폴더 짝짓기가 어긋나는 지점입니다. 있으면 첫 동기화 전에 정리하세요.</p>
    ${listOrNone(f.duplicateSiblingFolders, (x) => `×${x.count}  ${x.parent} / ${x.title}`)}

    <h2>쿼리스트링에 비밀값 패턴 <span class="pill">${f.secretsInQuery.length}</span></h2>
    ${listOrNone(f.secretsInQuery, (x) => `${x.path}\n        ${x.url}`)}

    <h2>사설/내부 호스트 <span class="pill">${f.privateHosts.length}</span></h2>
    <p class="sub">외부 저장소로 나가면 내부 인프라 주소가 노출되는 항목입니다.</p>
    ${listOrNone(f.privateHosts, (x) => `${x.path}\n        ${x.url}`)}

    <h2>비정상 스킴 <span class="pill">${f.unusualSchemes.length}</span></h2>
    ${listOrNone(f.unusualSchemes, (x) => `${x.path}\n        ${x.url}`)}

    <h2>최상위 폴더 (프로필 식별용)</h2>
    <pre>${esc(d.roots.map((r) => `[${r.folderType}/${r.syncing === true ? 'account' : r.syncing === false ? 'local' : '?'}] ${r.title}\n    ${r.topLevel.join(' | ') || '(비어 있음)'}`).join('\n'))}</pre>
  `
}

async function run() {
  try {
    LAST = await measure()
    render(LAST)
  } catch (e) {
    document.getElementById('out').innerHTML =
      `<h2 class="bad">측정 실패</h2><pre>${esc(e && e.stack ? e.stack : String(e))}</pre>`
  }
}

document.getElementById('dl').addEventListener('click', () => {
  if (!LAST) return
  const name = 'bookmark-probe-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'
  const blob = new Blob([JSON.stringify(LAST, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
})

document.getElementById('copy').addEventListener('click', async () => {
  if (!LAST) return
  const d = LAST
  const s = [
    'rootChildren=' + d.totals.rootChildren,
    'urlEntries=' + d.totals.urlEntries,
    'uniqueUrls=' + d.totals.uniqueUrls,
    'folders=' + d.totals.folders,
    'localRootsVisible=' + d.verdicts.localRootsVisibleToApi,
    'accountRoots=' + d.verdicts.accountRootCount,
    'dupUrls=' + d.findings.duplicateUrls.length,
    'dupSiblingFolders=' + d.findings.duplicateSiblingFolders.length,
    'secrets=' + d.findings.secretsInQuery.length,
    'privateHosts=' + d.findings.privateHosts.length,
    'managed=' + d.findings.managedNodes,
    '',
    ...d.roots.map((r) => `${r.id}\t${r.folderType}\tsyncing=${r.syncing}\t"${r.title}"\tchildren=${r.directChildren}\turls=${r.urlCount}`),
  ].join('\n')
  await navigator.clipboard.writeText(s)
  const b = document.getElementById('copy')
  b.textContent = '복사됨'
  setTimeout(() => (b.textContent = '요약 복사'), 1500)
})

document.getElementById('re').addEventListener('click', run)

run()
