# 에이전트 작업 규칙

**전체 규칙은 [CLAUDE.md](CLAUDE.md)에 있다. 작업 전에 읽는다.** 아래는 어겼을 때 되돌리기 어려운 항목만 추린 것이다.

이 저장소는 실제로 돌아가는 서비스이며 `https://bot.myxcloud.co.kr`로 외부에 공개돼 있다.

## 작업 위치

- `MyBot` = **실서비스**(launchd가 이 폴더를 그대로 실행, 포트 5274). 여기서 개발하지 않는다.
- `MyBot-dev` = 개발 인스턴스(포트 5275). 또는 자기 워크트리에서 작업한다.

## 배포

`release` 브랜치로 밀면 실서비스 **설정 → 업데이트** 화면에 뜨고, **관리자가 눌러야** 적용된다. 다른 경로로 배포하지 않는다. 실서비스 폴더의 파일을 직접 고치지 않는다.

## 절대 하지 않는 것

1. `evolve/surfaces.json`의 `protected` 목록에서 항목을 빼지 않는다. 이 목록이 봇의 자기개선이 인증 코드를 고치지 못하게 막는다. `server/src/guardrails.test.ts`가 이를 지키며, 깨지면 릴리스 적용이 실패한다.
2. 인증을 우회하는 경로를 만들지 않는다. `/api/health` 외에 무인증 엔드포인트를 늘리지 않고, 접속 암호를 URL 쿼리로 받지 않는다.
3. `server/src/approvals.ts`의 자동 허용 범위를 넓히지 않는다.
4. 접속 암호·API 키·메일 비밀번호를 대신 만들거나 입력하지 않는다. 사용자가 직접 넣는다.
5. 워크트리를 여러 세션이 공유하므로 `git reset --hard`로 남의 작업을 날리지 않는다.

막히면 우회하지 말고 사용자에게 말한다. 막히는 게 정상인 경우가 많다.

## 검증

```bash
cd server && NODE_ENV=test bun test     # 전부 통과 (NODE_ENV 없이 돌리면 운영 DB를 건드린다)
cd server && bunx tsc --noEmit          # 0건
cd web && bunx tsc --noEmit && bun run build
```

루트 `build` 스크립트는 고장나 있다. 웹 빌드는 `web/`에서 한다.
