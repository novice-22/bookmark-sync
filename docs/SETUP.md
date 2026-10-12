# 설치 가이드

전제: Docker 가 돌아가는 서버 1대, 서버와 브라우저 PC 가 같은 VPN(예: Tailscale)에 있음.

## 1. 서버 — WebDAV 띄우기

```bash
git clone <이 저장소> && cd <저장소>/server
cp .env.example .env              # BIND_IP / DAV_SUBNET / ALLOWED_CLIENT_IP 채우기
cp config.example.yml config.yml
```

### 비밀번호 해시 만들기

비밀번호는 서버 셸에서 **직접** 인자로 넘기세요.

```bash
docker run --rm hacdias/webdav:v5.17.0 bcrypt '<비밀번호>'
# 출력된 $2a$... 를 config.yml 의 REPLACE_WITH_BCRYPT_HASH 자리에
chmod 640 config.yml && sudo chown 10001:$(id -gn) config.yml   # 컨테이너(uid 10001)가 읽을 수 있게
```

> ⚠️ Windows PowerShell 에서 `$pw | ssh ...` 처럼 **파이프로** 넘기지 마세요.
> 설정에 따라 문자열 앞에 BOM(보이지 않는 바이트)이 붙어서, 해시는 만들어지는데
> 실제 비밀번호로는 영원히 로그인이 안 됩니다. 서버에서 같은 파이프로 시험하면 통과해서 잘 안 잡힙니다.

### 볼륨 만들고 기동

```bash
docker volume create bookmarks_dav-data
docker run --rm -v bookmarks_dav-data:/data alpine chown -R 10001:10001 /data   # 빠뜨리면 쓰기 불가
docker compose config >/dev/null && docker compose up -d
```

### 방화벽

```bash
sudo bash firewall.sh
sudo bash firewall.sh --check
```

### 확인

```bash
# 바인딩이 VPN IP 에만 있어야 한다 (0.0.0.0 이면 즉시 내릴 것)
sudo ss -tlnp | grep 8095

# 익명 401, 인증 207
curl -s -o /dev/null -w '%{http_code}\n' http://<BIND_IP>:8095/
curl -s -o /dev/null -w '%{http_code}\n' -X PROPFIND -H 'Depth: 1' -u 'floccus:<비밀번호>' http://<BIND_IP>:8095/
```

## 2. 브라우저 — 시작 전 백업

동기화 전에 **각 프로필에서** 북마크 관리자(`Ctrl+Shift+O`) → ⋮ → **북마크 내보내기**.
HTML 내보내기만이 북마크 생성일까지 보존하는 복구 수단입니다. 프로필 폴더의 파일 사본은 믿지 마세요(아래 참고).

선택: `extension-probe/` 를 압축해제 로드해서 두 프로필의 차이(중복 URL, 같은 이름 폴더, 위치가 다른 URL)를 먼저 확인하세요.
**같은 URL 이 두 프로필에서 다른 폴더에 있으면** 첫 동기화 때 중복이 됩니다. 한쪽 위치로 먼저 맞추세요.

## 3. floccus 빌드 (웹 스토어 대신)

웹 스토어판은 메인테이너가 올리는 대로 **자동 업데이트**된다. 악성 업데이트를 막을 수단이 없으므로 태그를 고정해 직접 빌드한다.
(**5.10.3 이상** — 5.10.2 에 Chromium 데이터 손실 버그가 있었음)

```bash
git clone --depth 1 --branch v5.11.1 https://github.com/floccusaddon/floccus.git floccus-src
cd floccus-src
git rev-parse HEAD                       # 릴리스 페이지의 태그 커밋과 같은지 확인
npm ci --ignore-scripts                  # lockfile 그대로, 설치 스크립트는 실행하지 않음
NODE_OPTIONS=--max-old-space-size=4096 npx gulp
```

릴리스 zip 과 같은 파일만 모아 확장 폴더를 만들고, 접근 권한을 내 서버 하나로 좁힌다 (원본은 `*://*/*`).

```bash
OUT=../floccus-ext && rm -rf $OUT && mkdir -p $OUT
cp -r dist icons lib _locales LICENSE.txt PRIVACY_POLICY.md README.md $OUT/ && rm -f $OUT/dist/js/test.js
node -e 'const m=require("./manifest.chrome.json");m.host_permissions=["http://<BIND_IP>:8095/*"];require("fs").writeFileSync(process.argv[1]+"/manifest.json",JSON.stringify(m,null,2))' $OUT
```

각 프로필에서 `chrome://extensions` → 개발자 모드 → **압축해제된 확장 프로그램 로드** → `floccus-ext`.
압축해제 확장이라 **개발자 모드를 계속 켜 둬야** 한다.

## 4. floccus 연결

| 항목 | 값 |
|---|---|
| 종류 | WebDAV |
| URL | `http://<BIND_IP>:8095/` (**끝에 `/`**) |
| 사용자 / 비밀번호 | `floccus` / 위에서 정한 것 |
| 북마크 파일 | `bookmarks.xbel` |
| **Passphrase** | **반드시 입력** — E2E 암호화. 두 프로필이 같아야 함 |
| 동기화 폴더 | 전체 |

### 첫 동기화 순서 — 중요

1. **북마크가 더 많은(모든 걸 담은) 프로필**에서 서버로 **덮어쓰기 업로드(⬆)** 1회
2. 다른 프로필에서 서버로부터 **덮어쓰기 다운로드(⬇)** 1회
3. 이후 둘 다 일반(merge) 동기화

> ⚠️ 두 번째 프로필은 **자동 동기화(변경 기반 · 시작 시 · 시간 기반)를 끈 채로** 만들고, ⬇ 를 한 뒤에 켜세요.
> 켜 둔 채로 만들면 생성 직후 병합이 먼저 돌아서 그 프로필의 배치가 서버에 올라가고,
> 다음 주기에 첫 번째 프로필까지 그 배치를 따라갑니다.
> 이미 그렇게 됐다면: 기준 프로필에서 ⬆ → 다른 프로필에서 ⬇ 를 **기준 프로필의 다음 자동 동기화 전에** 하면 됩니다.

2번은 받는 쪽에만 있던 북마크를 지웁니다. 두 프로필이 **서로 다른 북마크를 가지고 있다면**,
1번 프로필에 다른 쪽 전용 북마크를 먼저 옮겨서 합집합으로 만든 뒤 시작하세요.
첫 동기화에서는 floccus 의 대량 삭제 차단(20%)이 대개 발동하지 않으므로, 사람이 확인하는 수밖에 없습니다.

## 5. 백업

서버의 `bookmarks_dav-data` 볼륨을 주기적으로 묶어 두세요. 내용은 passphrase 로 암호화된 상태입니다.

```bash
docker run --rm --network none -v bookmarks_dav-data:/src:ro alpine tar czf - -C /src . > bookmarks-dav-$(date +%F).tar.gz
```
