# MyBot 응답 지연 개선 + 비서실장봇 폐지 (2026-09-18)

## 현재 진행 — E2-A 오프라인 격리 기반 완료, E2-B 대기

개선 지침서 E2를 한 번에 완료 처리하지 않고 나눴다. **E2-A는 dev 소스와 fixture 검증까지 완료**, 실제 골든 업무·모델·외부 도구를 연결하는 **E2-B는 미착수**다. 총괄 설계·최종 리뷰와 제한된 코드 게이트는 Astra high, 구현·테스트 작성은 GPT-5.6-Sol의 소스→패치 API로 수행했고 반환 모델을 확인했다. 테스트 작업자는 공개 계약을 기준으로 독립 작성한 뒤 구현을 읽고도 positive control을 약화하지 않은 채 계약 fixture만 고쳤다. 한 테스트 작업자의 HTTP 500 실패는 같은 Sol로 재시도해 완료했으며 다른 모델은 사용하지 않았다.

### E2-A 완료 범위

- [x] dev의 기존 미커밋 변경과 byte guard를 보존하고 `server/src/evolve.ts`, `server/src/evolve/isolation.ts`, `server/src/evolve/snapshot.ts`, `server/src/evolve/protocol.ts`, `server/src/evolve/worker.ts`, 신규 테스트 2개 등 7개 소스·테스트 파일을 통합했다.
- [x] `/private/tmp/mybot-e2.xgMJCA/integration`의 검증 스냅샷과 통합된 7개 파일이 바이트 단위로 일치함을 확인했다.
- [x] 앱 소스를 한 번 동결하고 **커밋 SHA가 아니라 실제 dirty bytes의 SHA-256**을 기록한다. 기준선·후보 arm마다 새 Bun PID, 별도 private DB/workspace, 동일한 합성 seed와 실제 schema 복제본을 사용한다.
- [x] 후보에만 바뀐 literal을 읽는 code/probe로 실제 기준선·후보 코드가 구분됨을 검사한다. 초기 상태는 `initialStateKind=synthetic-seed-and-schema`와 `initialStateHash`로 **초기화 레시피**에 결속되며, 실제 SQLite 전체 바이트나 운영 상태와 동일하다는 뜻은 아니다.
- [x] 알려진 canonical 설치 dependency root만 허용하고 128 MiB·30,000개·깊이 20 제한과 파일/link manifest를 적용한다. 각 arm에 private `node_modules`를 복사하고 실행 전후 dependency hash를 검사한다. source 불변성, traversal·ancestor·link·보호 경로 거부를 검증했다.
- [x] 부모를 포함한 신뢰 harness 4개 파일, Bun 실행 파일 hash/version, PID·exit/signal·시작/종료 시각·실제 policy hash를 영수증에 남긴다. timeout이나 출력 한도 초과 시 process group을 종료하고 실제 종료를 기다린 뒤 정리한다.
- [x] OS 정책은 strict deny-by-default read boundary와 network/fork 차단이며 macOS `sandbox-exec`만 지원한다. 미지원 OS나 정책 적용 실패는 fail closed다.
- [x] typecheck preflight는 지정된 후보 fixture module을 대상으로 유효 fixture PASS와 무효 type FAIL을 모두 검사했다. native global TypeScript 7 launcher의 fork가 차단되어, 별도 설치 없이 이미 설치된 web pure-JS TypeScript 5.9.3을 사용했다. 이는 실제 Golden 전체의 typecheck를 완료했다는 뜻이 아니다.
- [x] 외부의 명시적 TypeScript compiler는 별도 신뢰 입력이며 compiler lib directory read 예외를 가진다. frozen/hash dependency graph에는 포함되지 않으므로 모든 toolchain이 완전히 불변이라고 주장하지 않는다.

### 검증 근거와 경계

- 일반 회귀 166개와 신규 wire 5개는 OS 네트워크·호스트 자격 증명 차단, 메모리 DB, blocked fetch 조건에서 **171 pass / 0 fail, 656 assertions, 19 files**였다.
- E2 OS suite는 검토된 통제 테스트 부모(메모리 DB preloader, blocked fetch, 소유 임시 폴더)에서 실제 후보 worker마다 OS sandbox를 적용해 **23 pass / 0 fail, 209 assertions, 1 file**였다.
- 두 실행의 합계는 **194 pass / 0 fail, 865 assertions, 20 files**다. 두 suite를 하나의 외부 sandbox 실행으로 합쳐 표현하지 않는다. macOS가 nested sandbox를 거부하므로 E2 OS suite의 테스트 부모 자체는 외부 OS sandbox에 갇히지 않았고, 부모 테스트 코드는 합성 소스·파일만 사용했다. 테스트 부모의 모든 host read가 차단됐다고 주장하지 않는다.
- 부모 서버 TypeScript 7.0.2 검사와 `git diff --check` 통과가 확인됐다. Astra high는 source/dependency read boundary와 hash 보정 뒤 제한된 E2-A 코드 게이트를 통과시켰고, 마지막 production 변경 뒤 171개 회귀 재실행도 확인했다. 총괄 orchestration 설계·최종 리뷰 역시 Astra high였다.
- MyBot 업무 벤치용 실모델·실계정·운영 데이터·자격 증명은 사용하지 않았고 실제 성능·품질·비용 향상을 측정하지 않았다. 개발 작업자 모델 호출과는 별개다. 합성 row/workspace 독립성은 검사했지만 실제 운영 상태 전체의 동등성은 검사하지 않았다.

### 현재 런타임 의미와 다음 단계

- preflight는 더 이상 실행 중 소스·DB에 후보를 live apply/revert하지 않는다. `runGoldenTask`, `autoResolveApprovals`, `applyCandidate`의 기존 실행 경로는 비활성화됐고 `runBench`는 빈 inconclusive를 반환한다. `runCycle`에 넘긴 baseline은 사용하지 않으며 production runner 결과는 점수와 무관하게 `promotionEligible:false`다.
- **이 소스가 실행될 때** daily tick은 모델 제안·후보 생성·계측 전에 코드로 보류된다. E2-B가 연결되기 전 자동 제안·측정·업데이트를 하지 않는 동작이며, 지금 실행 중인 프로세스를 중지시켰다는 뜻은 아니다. exported `proposeCandidate`·`materializeCandidate`의 수동 직접 호출, 관리자 `applyUpdateOps`, 수신 pending update 경로는 보존돼 있어 모든 live 호출이나 incoming package가 전역 차단됐다는 뜻은 아니다.
- 기존 pure `judge` E1 테스트의 수치는 유지되지만 현재 runtime gate는 어떤 새 runner 결과도 승격하지 않는다. E6의 legacy autoResolve 경로 비활성화는 E6 전체 해결이 아니며, E7 서비스 수신·적용 검증도 남아 있다.
- [ ] **다음 우선순위 E2-B:** 격리 worker에 실제 Golden/model bridge를 연결하고 안전한 credential broker, 외부 도구 정책, 승인·취소 정책(E6)을 마련한다.
- [ ] 이후 E3 동일 조건·holdout, E4 비용 계측, E7 서비스 검증 영수증을 구현한다.
- [ ] 실행 중 dev 프로세스의 버전·자동 reload 여부를 확인한다. 이번에는 재시작·서비스 write·배포·release·commit·설치·실제 benchmark·외부 Telegram/메일 전송을 하지 않았다.

이번 단계에 UI 변경이나 새 웹 빌드는 없다. 아래 알림·승인 UX의 빌드 근거는 이전 단계 기록이며 E2-A에서 새로 실행한 결과가 아니다.

## 완료 기록 — 최종 결과 1회 전달·사람용 승인 문구

사용자 지시: E2 전에 Telegram/대화창의 과도한 중간 알림을 줄이고 최종 핵심요약만 제공한다. 승인과 운영 화면은 도구 식별자 대신 이해 가능한 문구를 쓴다. 승인을 없애거나 위험·대상을 감추지 않는다.

개발 모델 정책: 총괄·설계·최종 리뷰는 `gpt-6-astra / high`만 담당한다. 실제 구현과 테스트 작성은 모두 `gpt-5.6-sol`의 소스 입력→패치 출력 API로 수행했고 반환 모델을 확인했다. 아래 E1의 Astra medium 사용은 이전 정책에 따른 역사적 기록이다. 운영 봇의 live 모델 설정은 변경하지 않았다.

### 현재 상태와 검증 체크리스트

- [x] Astra high 설계 검토: 웹·Telegram·루틴·승인 재개·비동기 위임을 하나의 root command job으로 연결하고 최종 owner만 사용자에게 보고하는 구조를 확정.
- [x] GPT-5.6-Sol 구현·테스트 후보 생성: CLI 파일 도구 대신 소스 입력→패치 출력 API를 사용했고 presentation/backend를 포함한 실제 구현·테스트 산출물의 반환 모델을 확인.
- [x] 격리 후보 `/private/tmp/mybot-notification-ux.y2zsp0/integration`에서 전체 **166 pass / 0 fail, 624 assertions, 18 files** 확인. 신규 47개는 사람용 표현 19개, 전달 12개, 알림 4개, 승인·계정 통합 8개, 취소·초기화·동시 완료 4개다.
- [x] 네트워크 차단·호스트 인증 접근 차단·메모리 DB·mock fetch 조건으로 테스트. 기존 조직 테스트는 삭제하지 않고, 불필요한 formatter 추가 호출 기대를 “호출 없음 + 실제 run 결과 + 합성 메시지 추가 없음”으로 바꿨다.
- [x] 웹 TypeScript 검사 통과.
- [x] 서버·웹 TypeScript 검사 통과. dev 통합 뒤 서버 타입 검사와 `git diff --check`도 통과.
- [x] 격리 스냅샷의 웹 빌드 통과. 500kB 이상 번들 경고는 남아 있으며 이번에 성능 최적화하지 않았다. 산출물은 서비스·dev 실행 빌드에 복사하지 않았다.
- [x] Astra high 최종 코드 게이트 통과: 승인/거부 경합, 계정 저장 전 대상 검증, 취소·초기화 실패, 형제 실행 동시 완료, 최종 결과 저장의 트랜잭션 경계를 보정한 뒤 dev 소스 통합 승인.
- [x] 검증된 소스·테스트 25개를 dev에 통합하고 격리 스냅샷과 바이트 단위 일치 확인. 착수 시점의 기존 미커밋 변경과 별도 작업 파일은 보존.
- [ ] 실행 중인 dev 프로세스의 버전 일치·실사용 검증. 소스 반영만 완료했으며 프로세스를 재시작하지 않았다.
- [ ] 서비스 전달·사용자 승인·적용·재시작·실행 검증. 실제 외부 메시지 전송도 수행하지 않았다.

### 구현 후보의 범위

- 채팅·그룹·팀·루틴·위임·승인·자격 증명 요청을 영속 command job과 root correlation으로 연결한다. 간결한 표시용 `content`와 원본 `full_content`를 분리하고 내부 실행 로그는 사용자 채팅으로 합성하지 않는다.
- Telegram은 성공 시 최종 평문 1건, 사용자 조치가 필요하면 action-needed 1건만 만든 뒤 같은 메시지 ID를 편집한다. 채널별 영속 CAS로 전달 소유권을 정하며 결과가 불명확하면 자동 재전송하지 않는다.
- 작업 시작 시 대상과 자격 증명 fingerprint를 고정한다. dev에서는 실제 Telegram 발송·polling과 SMTP 발송을 차단한다.
- 승인 화면은 대상과 위험을 사람용 한국어로 표시하고, 원시 세부 정보는 기본 닫힘·민감값 정제 상태로 둔다. “항상 허용”은 넓은 도구 범위를 명시한 별도 체크박스를 직접 선택해야만 활성화된다.
- 검색·팀 실행의 상세 진행 기록은 “작업 상세 보기” 안에 기본 접힘으로 보존한다. 간단한 진행 상태와 필요한 팀 계획 승인은 계속 표시한다. 도구 이름이 제목으로만 전달되는 경우도 사람용 명칭으로 바꾼다. 이 마지막 표시 보정도 Astra high 리뷰·웹 타입 검사·격리 빌드를 거쳤다.
- 승인 큐 오류는 다음 요청에서 한국어 상태로 초기화하고, 상태 polling은 최신 항목뿐 아니라 모든 관련 메시지를 갱신한다. 승인 CAS와 영구 규칙 저장은 하나의 transaction으로 처리하며 자격 증명은 저장 전에 요청 대상과 일치하는지 검증한다.
- 재시작 시 이미 실행 중이던 rooted job과 오래된 종속 prompt는 중단·만료 처리하고 부작용 작업을 자동 재생하지 않는다. 아직 시작하지 않은 team plan 대기는 보존한다. 실패한 action은 무한 자동 재시도하지 않고 사용자가 다시 요청하게 한다.
- 원래의 전체 결과와 실행 근거는 내부 이력에 보존한다. 최종 요약을 짧게 만드는 것이 원문 증거 삭제를 뜻하지 않는다.

### 개발 환경 동작 변경과 안전 경계

- dev의 예약 실행과 원래 명령에 연결되지 않은 과거 실행의 자동 재개는 `MYBOT_DEV_AUTORUN=1`을 명시해야 동작한다. 새 설정은 실제 환경에 지정하지 않았다.
- opt-in 여부와 관계없이 dev의 실제 Telegram 발송·polling과 SMTP 발송 차단은 유지한다.
- `startEvolveLoop()`는 기존 정책대로 `MYBOT_ENV=dev` 조건만 사용한다. 사용자 범위의 알림·승인 변경은 자기개선을 자동으로 끌 권한이 없으므로 `MYBOT_DEV_AUTORUN` 조건을 추가하지 않는다.
- 이는 dev 전체의 외부 영향 격리를 뜻하지 않는다. 일반 브라우저/MCP 도구와 자기개선의 외부 효과 격리는 E2/E6의 미완료 과제다.
- 서비스 소스 수정·명시적 재시작·배포·브랜치 변경·커밋·release·실제 외부 메시지 전송은 하지 않았다. 실행 중인 dev의 소스 감시·자동 재로딩 여부와 실행 버전은 별도로 확인하지 않았다.

### UI 확인 범위

- [x] mock preview에서 한국어 라벨, 기본 비활성인 항상 허용, 체크박스 선택 후 활성화, 다음 요청의 상태 초기화, 명시적 사용자 오류, 닫힌 전체 결과를 열어 보는 흐름, 가짜 secret 마스킹을 확인.
- [x] 실제 React 컴포넌트를 띄운 모의 화면에서 이번 요청 실행·거부·앞으로도 허용·거부하고 매번 확인의 요청 값과 오류 안내를 확인. 390×844 화면에서 가로 넘침 없이 네 버튼에 접근 가능함을 확인. 임시 화면과 확인용 서버는 종료했다.
- [ ] 운영 인증을 거친 전체 화면, 실제 Telegram/메일 발송, 실제 모델로 수행하는 업무는 검증하지 않았다. 위 UI 확인은 백엔드 호출을 차단한 합성 데이터 화면이다.
- [ ] 성능 개선이나 모델 응답 품질 향상을 측정하지 않았다.

단순 성공은 최종 보고 한 건, 승인 대기는 완료로 표시하지 않는다. 사용자 조치가 필요한 요청은 숨기지 않되 같은 명령의 여러 승인으로 알림을 반복하지 않는다. 원문 결과는 내부 이력/전체 결과 보기에 보존하고, 외부 전송 성공 여부가 불확실하면 무조건 재발송하지 않는다.

이번 UX 요청의 dev 소스 구현·격리 검증은 완료했다. 이후 E2-A(기준선·후보의 독립 프로세스 실행과 코드 식별)도 위 현재 진행 기록처럼 완료했으며, E2-B와 E3(동일 조건·holdout 비교)가 다음 단계다. 서비스 적용은 별도의 관리자 업그레이드 단계다.

검증 중 발견한 실패는 수정 후 다시 실행했다. 특히 잘못된 provider 이름은 실제 초기화 오류가 아니라 기본 모델로 폴백하므로, 초기화 오류 테스트는 복원 가능한 `resolveModel` spy로 명시적 예외를 주입했다. 재시작 복구는 메모리 DB의 상태 전이와 SQL 저장 실패 주입으로 검증했으며 실제 프로세스 강제 종료·재시작 시험을 했다는 뜻은 아니다. 기존 자기개선의 선승인 실행 호출도 결과를 잃지 않도록 호환·중복 실행 테스트를 추가했다. 벤치의 자동 승인 범위 자체(E6)는 이번에 변경하지 않았다.

## 2026-09-19 개선 지침서 E1 — GPT 병렬 구현·검증

Understood as: 사용자 지시에 따라 GPT만 사용한다. 총괄 설계와 최종 리뷰는 `openai/gpt-6-astra / high`, 구현·독립 테스트는 `openai/gpt-6-astra / medium`으로 병렬 수행하고 dev에만 통합한다. 서비스·release 채널·실제 벤치는 변경하거나 실행하지 않는다.

이 배정은 개선 지침서를 수행하는 개발 에이전트의 배정이다. MyBot 상주 봇이나 운영 프로바이더 설정을 변경한 것이 아니다.

### 완료한 작업

- [x] dev 기존 미커밋 변경 보존. 착수 당시 evaluate.ts/evolve.ts는 서비스와 동일했으며, 이번 E1 변경만 선별했다.
- [x] 구현 작업자: 평가 호출·파싱 오류·취소를 `inconclusive`로 처리하고 단일 JSON·점수·issues 형식을 엄격히 검사.
- [x] 독립 테스트 작업자: 구현 파일을 읽지 않고 공개 계약으로 평가기 테스트 40개 작성.
- [x] 통합: checkTask → runBench → judge에 평가 불능 전파. 이전 원장·빈 검사·NaN/Infinity를 보류하고 불완전한 기준선이면 후보 계측 전 중단.
- [x] 새 근거 판정 모듈을 자기개선 보호 경로에 등록. preflight 자식 테스트의 NODE_ENV=test를 명시.
- [x] 원래 구현에 제공자 실패 fixture를 넣어 `pass:true, score:100` 문제 재현.
- [x] 새 E1 관련 53개 테스트와 전체 119개 테스트 통과(13파일, 417 assertions). 서버 타입 검사·diff 공백 검사 통과.
- [x] Astra high 최종 리뷰에서 E1 범위 승인. 조건부 DB 격리 우려는 db.ts 분기 확인과 preflight 환경 명시로 해소.
- [x] 검증 스냅샷의 서버 소스 52개가 dev 소스와 일치함을 확인. 기존 다른 작업자의 변경은 유지.
- [x] 60초 deadline 설정과 끝나지 않는 모의 호출에 대한 평가 대기 종료를 단축 시간 signal로 검증. 실제 60초 대기·실모델 실행의 물리적 중단을 검증한 것은 아님.
- [ ] 서비스 업그레이드 후보 전달·실제 반영·실행 검증은 미수행.

### 검증 경계

테스트는 `/private/tmp/mybot-e1-workers.WHp567/integration`의 dev 소스 스냅샷에서 실행했다. 메모리 DB, 네트워크 차단, 호스트 인증 파일/키체인 접근 차단, 격리 임시 폴더를 사용했다. `server/test-preload.ts`는 테스트 전용이며 모의 fetch와 기존 API 테스트용 기본 모델 식별자만 설정한다. 이 식별자의 GLM을 실제로 호출하거나 운영 모델을 바꾸지 않는다.

실행 명령의 핵심은 `NODE_ENV=test TMPDIR=<격리 임시 경로> bun test --preload ./server/test-preload.ts server/src`이며 위 OS sandbox 안에서 실행했다. 공유 fetch mock·타이머 spy가 있으므로 `--concurrent`는 사용하지 않았다. 타입 검사는 `tsc --noEmit -p .`로 실행했다.

처음 전체 실행의 6개 실패는 기존 테스트의 OS 임시 폴더 권한 4건과 호스트 CLI 기본 모델 선택 2건이었다. 테스트용 TMPDIR와 메모리 DB mock 라우팅을 고정한 뒤 전체 통과했다. 검증 환경 조정을 회귀 수정이나 성능 개선으로 부풀리지 않는다.

기존 E2(후보 격리 실행), E3(동일 조건·holdout), E4(비용), E7(서비스 패키지 검증)과 실서비스 검증은 완료하지 않았다. E1 테스트 통과가 자기개선 전체의 안전성을 보증하지 않는다.

### 이전 작업자 시도 기록 (현재 계획에서 종료)

GLM Flash는 역할 형식 오류 후 호환 경로에서도 제공자 오류1113(리소스 부족)으로 실패했다. SWE-2 Max는 승인받은 단일 임시 폴더를 신뢰 등록했지만 360초 내 산출물 없이 종료했다. 사용자 요청으로 GPT만 사용하는 계획으로 전환했으며 더 이상 이 두 모델을 재시도하지 않는다. 당시 임시 통합 초안 테스트 10개는 중간 기록이지 최종 검증 수치가 아니다.

아래 2026-09-18 기록은 과거 작업이다.

사용자 지시: "1번 멈추자. 개선 제안 우선순위로 진행하자. 비서실장봇을 제거하고 업무를 간소화한다.
비서실장이 하는 일은 CEO가 직접 담당하고 Eggbot은 그대로 업무를 진행한다."

## 0. 연쇄 실행 중지
- [x] DB 백업 `server/data/mybot-backup-20260918-013455-before-stop.db`
- [x] launchd 서비스 내림 (재시작 시 running 실행 자동 재개를 막기 위해)
- [x] 실행 중 3건 → error(사용자 요청 중단), 승인 대기 50건 → expired (재개 실행 없이)
- [x] CEO 역할문 누적 수정(분기 8c5fb40)을 작업 트리에 적용 — 테스트 4건 통과

## 개선 (우선순위순)
1. [x] 핑퐁 가드 수정 (team.ts agent_direct·agent_message) → 한도 초과 차단 테스트
2. [x] 위임·메시지 체인 순환 차단 (A→B→A 금지, 회신 재실행도 체인 유지) → 테스트
3. [x] 승인 요청 중복 방지 (같은 대상 봇 agent_update 대기 요청은 최신으로 교체) → 테스트
4. [x] 백그라운드 실행 전체 중지 API + 사이드바 버튼 → 테스트 + 웹 빌드 + 화면 캡처
5. [x] 보고서 정리(normalizeReport)를 호출자 반환 뒤 백그라운드로 → 테스트
6. [x] 채팅 최종 답변 이중 생성 제거 → 테스트 (수정 끄면 실패 확인)
7. [x] Eggbot 모델 교체(gpt-6-astra) + 429 발생 모델 2분 쿨다운 → 테스트
8. [x] 위임(중계) 실행은 품질 평가·보고서 재작성 생략 → 테스트 (수정 끄면 실패 확인)
9. [x] 대화 요약을 답변 뒤 백그라운드로 → 테스트
10. [x] 역할별 도구 세트(CEO·Eggbot은 브라우저·데스크톱 도구 제외) + 규칙 문구 중복 정리 → 테스트 + 크기 측정

## 11. 비서실장봇 폐지 — CEO 직접 배정, Eggbot 유지
- [x] 코드: 비서실장 특수 역할·라우팅 알림·삭제 보호·프롬프트 문구 제거, CEO 프롬프트에 배정·취합 책임 이관
- [x] 데이터(백업 `mybot-backup-20260918-020424-before-secretary-removal.db`): 비서실장봇 삭제, 역할문 6개 갱신, 기억 61건 보관(archived), CEO 요약 갱신, CEO·Eggbot 세션 공지
- [x] 파일: `agents/비서실장봇` → `_archive/2026-09/agents-orphan/`, Eggbot 노트의 연쇄 실행 체크포인트 3건 분리 보관
- [x] 검증: 테스트 + DB 확인 (비서실장 역할 0, 회상 대상 기억 0, 주입 노트 구간 0)

## 최종 검증
- [x] `bunx tsc --noEmit -p .` 통과, 웹 tsc 통과, 웹 빌드 통과
- [x] `bun test server/src` 16건 통과
- [x] 서비스 재시작 → health ok, stderr 새 오류 없음, 실행 중 0건, 새 빌드 서빙, stop-all 200

## 리뷰
- 봇 1회 호출 고정 입력(업무 노트 제외, 같은 조건 측정): CEO 시스템 프롬프트 2,761→1,642자, 도구 42개(14,776자)→19개(7,148자) / Eggbot 동일 수준 / 팀장·실무 봇 프롬프트 약 17~19% 감소, 도구는 그대로
- 분석 때 말한 "고정 프롬프트 8,600자"는 소스의 모든 역할 분기를 합산한 과대 수치였음 — 실제 1회 호출 기준은 위 표
- 남은 결정: `default_model`이 zai/glm-5.3-flash라 품질 평가·보고서 정리·대화 요약·기억 추출이 GLM으로 감 (새 봇 기본 모델이기도 해서 변경하지 않음)
- 실제 지시로 응답 시간을 재는 것은 사용자 세션·모델 사용량에 기록이 남아 하지 않음
- 테스트 인프라: `bun test`는 NODE_ENV=test로 메모리 DB를 쓴다. 루트에서 `bun test`만 치면 작업 폴더의 봇 임시 스크립트(`_archive/*_test.ts`)까지 잡히므로 `bun test server/src`로 실행
