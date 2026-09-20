#!/bin/sh
# git 훅 설치 — 실서비스 워크트리에서의 직접 커밋을 막는다.
# 훅은 .git 안에 살아 저장소에 커밋되지 않으므로, 새 환경에서는 이 스크립트를 한 번 실행한다.
#   sh scripts/install-hooks.sh
set -e

HOOKS="$(git rev-parse --git-common-dir)/hooks"
mkdir -p "$HOOKS"

cat > "$HOOKS/pre-commit" <<'HOOK'
#!/bin/sh
# 실서비스 워크트리(master를 체크아웃한 운영 폴더)에서는 커밋하지 않는다.
# launchd가 그 폴더를 그대로 실행하므로, 여기서 고친 코드는 검증 없이 다음 재시작에 반영된다.
# 개발은 MyBot-dev나 자기 워크트리에서 하고, 배포는 release 브랜치 → 관리자 화면 적용으로 한다.
# 자세한 규칙은 CLAUDE.md 참조.

branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
top=$(git rev-parse --show-toplevel 2>/dev/null || echo "")

case "$top" in
  *.claude/worktrees/*|*.codex/worktrees/*) exit 0 ;;  # 에이전트 작업 공간은 통과
esac

if [ "$branch" = "master" ]; then
  echo "거부: 실서비스 폴더(master)에서 직접 커밋하려 합니다." >&2
  echo "" >&2
  echo "  이 폴더는 launchd가 그대로 실행하는 운영 코드입니다." >&2
  echo "  개발은 MyBot-dev 또는 자기 워크트리에서 하고," >&2
  echo "  배포는 release 브랜치로 민 뒤 설정 → 업데이트 화면에서 적용하세요." >&2
  echo "" >&2
  echo "  릴리스 수령(merge --ff-only)은 커밋을 만들지 않으므로 이 훅에 걸리지 않습니다." >&2
  echo "  꼭 필요하면 git commit --no-verify 로 넘길 수 있지만, 먼저 CLAUDE.md를 읽으세요." >&2
  exit 1
fi
exit 0
HOOK

chmod +x "$HOOKS/pre-commit"
echo "설치 완료: $HOOKS/pre-commit"
