#!/usr/bin/env bash
# 커밋 전에 실행: 실제 환경값·비밀값이 섞였는지 검사한다.
#   bash scripts/check-leaks.sh            # 0 = 통과
# git pre-commit 훅으로 걸려면:
#   ln -s ../../scripts/check-leaks.sh .git/hooks/pre-commit
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
hit() { echo "✗ $1"; echo "$2" | sed 's/^/    /'; fail=1; }

# 커밋 대상(추적 + 스테이징) 파일. git 저장소가 아니면 전체 파일
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  files=$(git ls-files -co --exclude-standard)
else
  files=$(find . -type f -not -path './.git/*')
fi
[ -n "$files" ] || { echo "검사할 파일 없음"; exit 0; }

scan() { # $1 설명  $2 정규식
  local r; r=$(echo "$files" | xargs grep -nEI -- "$2" 2>/dev/null | grep -v 'scripts/check-leaks.sh' || true)
  [ -z "$r" ] || hit "$1" "$r"
}

# 실제 숫자로 된 CGNAT/Tailscale 주소 (예시 표기 100.x.y.z 는 통과)
scan "VPN(100.64/10) 실제 IP"        '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'
scan "bcrypt 해시"                   '\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{20,}'
scan "개인키"                        'BEGIN [A-Z ]*PRIVATE KEY'
scan "토큰류"                        '(ghp_|github_pat_|xox[abp]-|AKIA[0-9A-Z]{16}|tskey-)'
scan "비밀번호 대입"                 '(password|passwd|passphrase)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9]{12,}'

# 있으면 안 되는 파일
for f in server/.env server/config.yml; do
  echo "$files" | grep -qx "\./$f\|$f" && hit "커밋되면 안 되는 파일" "$f"
done
echo "$files" | grep -E '\.html$' | grep -v '^\.\?/\?extension-probe/' | sed 's/^/    /' | grep -q . \
  && hit "브라우저 북마크 내보내기(html) 로 보이는 파일" "$(echo "$files" | grep -E '\.html$' | grep -v 'extension-probe/')"

[ $fail -eq 0 ] && echo "✓ 통과 — 환경값·비밀값 없음" || echo "→ 위 항목을 지우고 다시 실행하세요"
exit $fail
