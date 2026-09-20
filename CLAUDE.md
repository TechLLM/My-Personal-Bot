# MyBot 작업 규칙

이 저장소는 **실제로 돌아가고 있는 서비스**다. macOS launchd가 상주 실행하며, `https://bot.myxcloud.co.kr`로 외부에 공개돼 있다. 작업하기 전에 이 문서를 끝까지 읽는다.

## 작업 공간

같은 저장소를 여러 워크트리가 공유한다. **어디서 작업하는지가 곧 안전 등급이다.**

| 경로 | 브랜치 | 성격 |
|---|---|---|
| `MyBot` | `master` | **실서비스.** launchd가 이 폴더를 그대로 실행한다(포트 5274) |
| `MyBot-dev` | `dev-env` | 개발 인스턴스(포트 5275) |
| `MyBot/.claude/worktrees/*` | `claude/*` | Claude 세션 작업 공간 |
| `~/.codex/worktrees/*` | `codex/*` | Codex 세션 작업 공간 |

**실서비스 폴더(`MyBot`)에서 개발하지 않는다.** 파일을 고치는 순간 다음 재시작에 그대로 반영되고, 검증 단계를 통째로 건너뛴다. 실서비스 폴더는 릴리스를 받는 곳이지 코드를 쓰는 곳이 아니다.

## 배포 워크플로

사용자가 정한 방식이다. **다른 경로로 배포하지 않는다.**

1. 개발은 `MyBot-dev` 또는 자기 워크트리에서
2. 검증(아래 기준)을 통과시킨다
3. `release` 브랜치로 밀면 → 실서비스 **설정 → 업데이트 → 서비스 릴리스**에 대기 목록이 뜬다
4. **관리자가 화면에서 직접 적용한다.** 적용 시 서버 테스트·타입검사·웹 빌드가 돌고, 하나라도 실패하면 받기 전 커밋으로 되돌아간다
5. 문제가 생기면 같은 화면의 되돌리기 버튼

`release`는 검증이 끝난 것만 올리는 채널이다. `master`는 여러 세션이 커밋하므로 배포 채널로 쓰지 않는다.

구현은 `server/src/release.ts`. 이 통로는 봇에게 도구로 노출하지 않는다 — 사람이 민 커밋을, 사람이 눌러야 들어온다.

## 절대 하지 않는 것

아래는 사용자 승인이 있어도 조용히 진행하지 않는다. 막히면 우회하지 말고 사용자에게 말한다.

1. **보호 경로 해제.** `evolve/surfaces.json`의 `protected` 목록에서 항목을 빼지 않는다. 이 목록이 봇의 자기개선이 인증·승인·릴리스 코드를 건드리지 못하게 막는다. 여기서 `server/src/access.ts`를 빼면 **봇이 스스로 인증을 풀 수 있게 된다.** 이 불변조건은 `server/src/guardrails.test.ts`가 지키며, 깨지면 릴리스 적용이 실패한다.
2. **인증 우회.** `installAccessControl`을 건너뛰는 경로를 만들지 않는다. `/api/health` 외에 무인증 엔드포인트를 늘리지 않는다. 접속 암호를 URL 쿼리로 받지 않는다(로그에 평문으로 남는다 — 그래서 `?key=`를 폐지했다).
3. **실서비스 직접 변경.** `MyBot` 폴더의 코드·`web/dist`·`server/data`를 손으로 고치지 않는다. 릴리스 통로로만 바꾼다.
4. **자격증명 생성·입력.** 접속 암호, API 키, 메일 비밀번호는 사용자가 직접 넣는다. 값을 읽거나 로그에 남기지 않는다.
5. **`git reset --hard`로 남의 작업 날리기.** 워크트리를 여러 세션이 공유한다. 되돌릴 일이 있으면 merge나 revert를 쓴다.
6. **승인 게이트 완화.** `server/src/approvals.ts`에서 자동 허용 범위를 넓히지 않는다. `shell_run`은 조회 명령만 자동 허용이며, 쓰기·네트워크·인터프리터는 사용자 승인을 받는다.

## 훅 설치 (환경마다 한 번)

실서비스 폴더에서 실수로 커밋하는 것을 막는 훅이다. `.git` 안에 살아 저장소에 따라오지 않으므로 새 환경에서 한 번 실행한다.

```bash
sh scripts/install-hooks.sh
```

릴리스 수령(`merge --ff-only`)은 커밋을 만들지 않아 훅에 걸리지 않는다.

## 검증 기준

릴리스에 올리기 전 아래를 모두 통과시킨다. 실서비스 적용 시 같은 검사가 다시 돌아간다.

```bash
cd server && NODE_ENV=test bun test     # 전부 통과
cd server && bunx tsc --noEmit          # 0건
cd web && bunx tsc --noEmit             # 0건
cd web && bun run build                 # 성공
```

- 테스트는 `NODE_ENV=test`에서 메모리 DB를 쓴다. 이 변수 없이 돌리면 **운영 DB를 건드린다.** 테스트 파일 첫 줄의 `db.filename !== ":memory:"` 가드를 지우지 않는다.
- 루트의 `build` 스크립트는 고장나 있다. 웹 빌드는 `web/`에서 한다.

## 서비스 운용

- 서비스 `ai.mybot.server`(5274), 개발 `ai.mybot.dev`(5275). 둘 다 launchd 상주이며 `KeepAlive=true`라 프로세스가 죽으면 자동으로 다시 뜬다.
- 코드를 바꾸면 재시작해야 반영된다: `launchctl kickstart -k gui/$UID/ai.mybot.server`
- 5274는 `web/dist`를 그대로 서빙한다. 화면을 바꿨으면 빌드해야 보인다.
- 허용 접속 주소는 `bot.myxcloud.co.kr`, `localhost:5274`, `127.0.0.1:5274`. 다른 Host로 오면 403이다. 주소를 늘리려면 `MYBOT_ALLOWED_ORIGINS`를 쓰고, 코드의 검사를 지우지 않는다.

## 봇의 자기개선과 릴리스는 다른 통로다

혼동하면 위험하다.

- **자기개선(`server/src/evolve.ts`, `/api/evolve/updates`)** — 봇이 제안한 *표면* 수정을 사람이 승인한다. 신규 파일을 만들지 못하고 보호 경로를 막는다. 규칙은 `tasks/self-improvement-contract.md`.
- **릴리스(`server/src/release.ts`, `/api/release`)** — 사람이 만든 코드 전체를 git으로 받는다. 신뢰 등급이 다르므로 통로를 분리했다.

자기개선이 막힌다고 해서 보호를 풀어 릴리스 대신 쓰지 않는다. 막히는 게 정상이다.

## 관련 문서

- `README.md` — 제품 설명·설치
- `tasks/self-improvement-contract.md` — 자기개선 루프 계약
- `tasks/access-stage1.md` — 접근 통제 1단계 작업 기록
- `개선지침서.md` — 남은 개선 과제
