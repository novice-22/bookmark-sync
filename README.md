# bookmark-sync

크롬 프로필 여러 개(예: 회사 구글 계정 / 개인 구글 계정)의 북마크를 **내 서버**를 통해 양방향 동기화하는 구성.
제3자 클라우드에 북마크를 맡기지 않는다.

```
[프로필 A · floccus] ──┐
                       ├── VPN ──▶ [self-hosted WebDAV] ──▶ 암호화된 bookmarks.xbel
[프로필 B · floccus] ──┘
```

- **동기화 엔진**: [floccus](https://github.com/floccusaddon/floccus) — 웹 스토어판 대신 **릴리스 태그 소스를 직접 빌드**해서 로드 (자동 업데이트 없음, 접근 권한을 내 서버 하나로 축소)
- **저장소**: 직접 띄우는 WebDAV ([hacdias/webdav](https://github.com/hacdias/webdav)) — 이 저장소의 `server/`
- **암호화**: floccus passphrase 로 E2E — 서버와 백업에는 암호문만 남는다
- **진단 도구**: `extension-probe/` — 읽기 전용 크롬 확장, 동기화 전 두 프로필 차이를 확인

## 왜 이 구성인가

| 고민 | 결론 |
|---|---|
| 크롬에 계정 2개 북마크를 합치는 기능? | 없다. 확장으로 트리를 읽고 써야 한다 |
| 직접 만들까? | 3-way 머지 엔진이 가장 위험한 부품이다. 검증된 floccus 를 쓴다 |
| GitHub private repo 에 올릴까? | floccus 의 **Git 어댑터는 E2E 암호화가 없다**. URL 이 평문으로 영구 커밋된다 |
| Google Drive? | 서드파티 OAuth 앱을 거친다 |
| → WebDAV + passphrase | 자기 서버 + 암호화 + OAuth·토큰 만료 없음 |

## 보안 기본값

- 포트는 **VPN IP 에만** publish (`BIND_IP`). 인터넷 비노출
- `firewall.sh` — 컨테이너의 외부 연결 전부 차단 + 허용한 클라이언트 IP 한 대만 접근
- 비root(uid 10001) · `cap_drop: ALL` · `no-new-privileges` · `read_only` · 메모리·PID 상한
- 이미지 digest 고정, bcrypt 해시만 저장

## 시작하기

[docs/SETUP.md](docs/SETUP.md)

## 알아두면 좋은 크롬 동작 (2026 기준)

- 최근 크롬은 로그인한 프로필의 북마크를 `Bookmarks` 가 아니라 `AccountBookmarks` / 암호화된 `EncryptedAccountBookmarks2` 에 저장한다.
  **프로필 폴더의 북마크 파일을 직접 읽는 도구는 깨질 수 있다.** `chrome.bookmarks` API 를 쓸 것
- 영구 폴더(북마크바 등) id 가 `1/2/3` 이 아닐 수 있다. `folderType` 으로 찾을 것
- 계정이 다르면 같은 북마크라도 내부 guid 가 전혀 겹치지 않고, 확장 API 는 guid 를 노출하지 않는다 → URL + 폴더 경로로 짝을 맞춘다
- 로컬 북마크가 하나도 없으면 "이 기기에서만" 영구 폴더가 확장 API 에서 숨겨진다
- 동기화되지 않는 것: 북마크바 **순서**, **favicon**(사이트를 처음 열 때 채워짐)

## 라이선스

이 저장소의 스크립트·확장 코드는 자유롭게 쓰세요. floccus(MPL-2.0)와 hacdias/webdav(MIT)는 각 프로젝트의 라이선스를 따릅니다.
