#!/usr/bin/env bash
# ============================================================
# WebDAV 컨테이너 전용 방화벽 (iptables DOCKER-USER 체인)
#
#   sudo bash firewall.sh          # 적용 (+ /etc/iptables/rules.v4 가 있으면 영속화)
#   sudo bash firewall.sh --check  # 상태만 확인
#
# 값은 같은 폴더의 .env 에서 읽는다: DAV_SUBNET, ALLOWED_CLIENT_IP
#
# 규칙 2줄:
#   1) egress  — 컨테이너가 스스로 거는 연결을 전부 차단 (인터넷·VPN·호스트).
#                WebDAV 는 받기만 하므로 나갈 이유가 없다.
#   2) ingress — 이 서비스로 들어오는 연결을 ALLOWED_CLIENT_IP 한 대로만 제한.
#                VPN 의 다른 기기(휴대폰 등)에서도 못 닿게 한다.
#
# 왜 --ctdir ORIGINAL 인가:
#   이게 없으면 정상 연결의 "응답" 패킷까지 걸려서 허용된 기기에서도 접속이 안 된다.
#   ORIGINAL 은 연결을 시작한 방향만 본다 → 응답(REPLY)은 통과한다.
#
# 규칙 2 의 -d 는 DNAT 이후 주소(컨테이너 IP)다. 서버 자신이 거는 점검용 curl 은
# docker-proxy 경유(OUTPUT 경로)라 이 규칙과 무관하다.
#
# 클라이언트 기기를 다시 설치해 VPN IP 가 바뀌면 .env 를 고치고 다시 실행하면 된다
# (구 규칙은 자동으로 걷어낸다).
# ============================================================
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
[ -f "$HERE/.env" ] && set -a && . "$HERE/.env" && set +a

: "${DAV_SUBNET:?.env 에 DAV_SUBNET 이 필요합니다}"
: "${ALLOWED_CLIENT_IP:?.env 에 ALLOWED_CLIENT_IP 가 필요합니다}"
RULES_V4=${RULES_V4:-/etc/iptables/rules.v4}
C_EGRESS="bookmarks-dav: no outbound connections"
C_INGRESS="bookmarks-dav: allowed client only"

egress_args=(DOCKER-USER -s "$DAV_SUBNET"
             -m conntrack --ctdir ORIGINAL
             -m comment --comment "$C_EGRESS" -j DROP)
ingress_args=(DOCKER-USER -d "$DAV_SUBNET" ! -s "$ALLOWED_CLIENT_IP"
              -m conntrack --ctdir ORIGINAL
              -m comment --comment "$C_INGRESS" -j DROP)

if [ "${1:-}" = "--check" ]; then
  iptables -L DOCKER-USER -n -v --line-numbers | grep -E 'num|bookmarks-dav' || true
  [ -f "$RULES_V4" ] && { grep -n 'bookmarks-dav' "$RULES_V4" || echo "(rules.v4 에 없음)"; }
  exit 0
fi

[ "$(id -u)" -eq 0 ] || { echo "root 로 실행하세요"; exit 1; }
iptables -N DOCKER-USER 2>/dev/null || true

# 클라이언트 IP 가 바뀐 구 ingress 규칙 제거
while read -r line; do
  [ -n "$line" ] || continue
  case "$line" in
    *"! -s $ALLOWED_CLIENT_IP/32 "*) ;;
    *) eval "iptables ${line/#-A /-D }" && echo "구 ingress 규칙 제거" ;;
  esac
done < <(iptables -S DOCKER-USER | grep -F -- "$C_INGRESS" || true)

for name in egress ingress; do
  declare -n R="${name}_args"
  if iptables -C "${R[@]}" 2>/dev/null; then
    echo "이미 적용됨: $name"
  else
    iptables -A "${R[@]}"
    echo "적용함: $name"
  fi
done

# ---------- 영속화 (iptables-persistent 를 쓰는 경우) ----------
# netfilter-persistent save 는 쓰지 않는다 — Docker 가 런타임에 만든 체인까지 통째로 저장되면
# 부팅 시 dockerd 보다 먼저 복원돼 어긋난다. 우리 규칙 두 줄만 손으로 넣는다.
[ -f "$RULES_V4" ] || { echo "$RULES_V4 없음 — 영속화 건너뜀 (재부팅 후 다시 실행 필요)"; exit 0; }

BAK="$RULES_V4.bak.$(date +%s)"
cp -p "$RULES_V4" "$BAK"

python3 - "$RULES_V4" "$DAV_SUBNET" "$ALLOWED_CLIENT_IP" "$C_EGRESS" "$C_INGRESS" <<'PY'
import sys
path, net, client, c_eg, c_in = sys.argv[1:6]
egress = ('-A DOCKER-USER -s %s -m conntrack --ctdir ORIGINAL '
          '-m comment --comment "%s" -j DROP' % (net, c_eg))
ingress = ('-A DOCKER-USER -d %s ! -s %s/32 -m conntrack --ctdir ORIGINAL '
           '-m comment --comment "%s" -j DROP' % (net, client, c_in))
decl = ':DOCKER-USER - [0:0]'
lines = open(path, encoding='utf-8').read().split('\n')
start = lines.index('*filter')
end = next(i for i in range(start + 1, len(lines)) if lines[i].strip() == 'COMMIT')
changed = False
if decl not in lines[start:end]:
    last = max([i for i in range(start + 1, end) if lines[i].startswith(':')] or [start])
    lines.insert(last + 1, decl); end += 1; changed = True
for l in [l for l in lines[start:end] if c_in in l and l != ingress]:
    lines.remove(l); end -= 1; changed = True
for rule in (egress, ingress):
    if rule not in lines[start:end]:
        lines.insert(end, rule); end += 1; changed = True
if changed:
    open(path, 'w', encoding='utf-8').write('\n'.join(lines)); print('PATCHED')
else:
    print('ALREADY')
PY

if ! iptables-restore --test "$RULES_V4"; then
  echo "rules.v4 검증 실패 → 원복"; cp -p "$BAK" "$RULES_V4"; exit 1
fi
echo "영속화 완료 (백업: $BAK)"
