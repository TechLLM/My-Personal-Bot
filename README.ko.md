# My-Personal-Bot

[English README](README.md)

맥미니(또는 아무 macOS/Linux 서버)에서 상시 실행되는 **개인용 AI 어시스턴트 웹앱**입니다.
Grok 스타일의 채팅 경험을 제공하면서, 특정 모델·벤더에 종속되지 않고 **원하는 모델을 자유롭게 연결**할 수 있습니다.

## 주요 기능

### 채팅 코어
- SSE 스트리밍 채팅, 대화 분기(편집/재생성/형제 탐색 ‹1/2›)
- 자동 대화 제목 생성
- 그록식 다크 미니멀 UI (좌측 대화 목록 + 하단 통합 프롬프트바)

### 멀티모델
- [airoute](https://github.com/) 같은 OpenAI-호환 프록시 연동 시 200개+ 모델 사용 가능
- 커스텀 OpenAI-호환 엔드포인트 등록 (Ollama, LM Studio, 임의 API)
- 프로바이더 → 네임스페이스 → 모델 2단 피커 (검색 + THINK/EYE/AUTO 배지)
- 대화별 모델 저장

### 모드
- **Think** — 추론 과정 접이식 패널 (`reasoning_content`/`<think>` 파싱)
- **DeepSearch** — 쿼리 분해 → 병렬 웹검색(Bing/SearXNG/Tavily/Brave) → 출처 정독 → [n] 인용 리포트
- **이미지** — OpenAI Images 호환 / Draw Things 로컬 생성 + 업로드 이미지 비전 분석
- **팀(대장 봇)** — 아래 참조

### 팀 모드 (멀티에이전트)
- 모든 대화는 봇에 귀속 — CEO 봇이 기본 담당, 모델을 바꿔도 봇의 기억·업무 맥락 유지
- 설정에서 **원하는 봇을 CEO로 지정** — CEO는 모든 봇의 관리자: 봇 현황 조회(`agent_list`), 임의 봇에게 즉시 지시(`agent_direct`), 역할·모델 수정(`agent_update`), 봇 정리(`agent_delete`)
- CEO 봇이 지시를 분석해 **작업 계획을 제시** — 사용자가 봇별 체크박스로 선택·승인하면 실행
- 역할 봇 자동 생성/재사용 후 병렬 분배 (최대 4개)
- 기존 상주 봇의 페르소나가 맞으면 재사용, 안 맞으면 새 페르소나로 신규 생성
- 루틴(예약 작업) 담당 봇은 자동 제외하고 새 봇 생성
- 각 봇에 **실제 할당된 모델명 표시** (별칭이 아닌 라우팅 대상, 예: `openai/gpt-6-astra@high`)
- 봇 도구: 웹검색, 공유 작업 디렉터리 파일 I/O, MCP 도구, 내장 브라우저, 루틴 등록(`routine_add`)
- 실행 과정이 실시간 봇 카드로 표시되고, CEO가 결과를 종합해 최종 답변

### 내장 브라우저 (로그인 세션 공유)
- 서버가 직접 구동하는 영속 프로필 Chromium (headless)
- 설정에서 "로그인 창 열기" → 수동 로그인 1회 → 봇이 세션 재사용
- **사이트 계정 등록**: 설정에 사이트별 아이디·비밀번호 저장 → 봇이 `browser_login`으로 자동 로그인 (회사 그룹웨어 메일·결재 목록 등 수집). 비밀번호는 로컬 DB에만 저장되고 모델에는 노출 안 됨
- 봇별 탭 격리, 자동화 탐지 신호 제거

### 생산성
- 페르소나 (기본/Fun/번역가/코드리뷰어/선생님 + 커스텀)
- 메모리: 대화에서 사용자 사실 자동 추출 → 이후 대화에 주입
- 워크스페이스: 프로젝트별 지침 + 대화 격리
- 스킬: `/요약` `/번역` 등 커스텀 슬래시 명령
- 루틴: `every:30m` / `daily:HH:MM` 예약 실행 → 결과를 대화로 저장 (특정 봇에 배정 가능)
- 음성: 브라우저 Web Speech STT(🎤) + TTS(🔊) — 무설치
- 결과 알림: 텔레그램 봇 / SMTP 메일로 답변·루틴 결과 발송 (기본은 채팅창만)
- MCP(Model Context Protocol) stdio 서버 연동
- 파일 첨부: 이미지(비전 분석), 텍스트 파일(내용 주입)
- 접속 암호 설정 시 API 전체 보호
- PWA 매니페스트 (홈 화면 추가 가능)
- 모든 데이터 로컬 SQLite 저장 — 외부 서버로 데이터 유출 없음

## 설치

### 요구사항
- [Bun](https://bun.sh) 1.4+
- 모델 공급원: airoute 프록시(`http://127.0.0.1:11441`) 또는 OpenAI-호환 엔드포인트

### 설치 및 실행

```bash
git clone https://github.com/TechLLM/My-Personal-Bot.git
cd My-Personal-Bot
bun install
bun --cwd web install
bunx playwright install chromium   # 내장 브라우저용 (선택)
bun run build                      # 웹 프론트 빌드
bun start                          # http://127.0.0.1:5274
```

### macOS 자동 기동 (launchd)

```bash
mkdir -p ~/Library/Logs/mybot
cat > ~/Library/LaunchAgents/ai.mybot.server.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ai.mybot.server</string>
  <key>ProgramArguments</key><array>
    <string>~/.bun/bin/bun</string><string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/절대경로/My-Personal-Bot</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>~/Library/Logs/mybot/stdout.log</string>
  <key>StandardErrorPath</key><string>~/Library/Logs/mybot/stderr.log</string>
</dict></plist>
EOF
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.mybot.server.plist
```

> launchd 로그 경로는 반드시 내장 볼륨(`~/Library/Logs`)을 사용하세요.

## 사용법

| 기능 | 방법 |
|---|---|
| 모델 선택 | 입력줄 왼쪽 모델 버튼 → 프로바이더/그룹/검색 |
| DeepSearch | "DeepSearch" 칩 켜고 질문 |
| 팀 모드 | "팀" 칩 켜고 업무 지시 → 대장이 봇 분배 |
| 이미지 생성 | "이미지" 칩 (설정에서 image_endpoint 필요) |
| 봇 로그인 | 설정 → 브라우저 → 로그인 창 열기 → 수동 로그인 |
| 스킬 | 입력창에 `/` 입력 → 자동완성 |
| 루틴/봇/페르소나 | 좌측 하단 ⚙ 설정 |

LAN의 다른 기기(아이폰 등)는 `http://<서버IP>:5274`로 접속 — 설정에서 접속 암호를 지정하는 것을 권장합니다.

## 설정 (⚙)

- `searxng_url` / `tavily_key` / `brave_key` — 검색 품질 향상
- `image_endpoint` / `image_model` — 이미지 생성
- `mcp_servers` — MCP 서버 JSON `[{"name":"fs","command":"npx","args":[...]}]`
- `access_code` — 접속 암호
- `system_prompt`, 메모리 관리, 페르소나/워크스페이스/스킬/루틴/에이전트 봇

## 기술 스택

Bun + TypeScript + Hono + SQLite(`bun:sqlite`) · React + Vite + Tailwind · Playwright(내장 브라우저) · SSE

## 데이터 위치

```
server/data/mybot.db       대화/메모리/봇/루틴 (SQLite WAL)
server/data/files/         업로드·생성 파일
server/data/workspace/     봇 공유 작업 디렉터리
server/data/browser-profile/  브라우저 로그인 세션 (git 제외)
```

## 라이선스

Copyright © 2026. All Rights Reserved.
본 소프트웨어는 저작권법의 보호를 받으며, 사전 서면 동의 없는 복제·수정·배포를 금합니다.
