export interface ApprovalPresentation {
  title: string;
  summary: string;
  risk: string;
  details: { label: string; value: string }[];
  technicalDetails?: string;
}

const TOOL_LABELS: Array<[RegExp, string]> = [
  [/^(read_file|file_read|read)$/i, "파일 읽기"],
  [/^(write_file|file_write|create_file)$/i, "파일 작성"],
  [/^(edit_file|patch_file|replace_file)$/i, "파일 수정"],
  [/^(delete_file|remove_file)$/i, "파일 삭제"],
  [/^(list_files|list_directory|directory_list)$/i, "파일 목록 확인"],
  [/^(search_files|grep|file_search)$/i, "파일 내용 검색"],
  [/^(web_search|deepsearch|search_web)$/i, "웹 검색"],
  [/^browser_login$/i, "사이트 로그인"],
  [/^ego_run$/i, "로그인된 브라우저 작업"],
  [/^browser_/i, "웹 페이지 작업"],
  [/^computer_/i, "컴퓨터 화면 조작"],
  [/^(send_email|mail_send)$/i, "이메일 보내기"],
  [/^(read_email|mail_read|mail_list)$/i, "이메일 확인"],
  [/^(send_telegram|telegram_send)$/i, "텔레그램 메시지 보내기"],
  [/^agent_direct$/i, "다른 봇에게 작업 전달"],
  [/^agent_message$/i, "다른 봇에게 메시지 전달"],
  [/^agent_create$/i, "새 봇 만들기"],
  [/^agent_update$/i, "봇 설정 변경"],
  [/^agent_(delete|remove)$/i, "봇 삭제"],
  [/^agent_(list|reorder)$/i, "봇 조직 관리"],
  [/^(routine_add|routine_create)$/i, "루틴 만들기"],
  [/^routine_update$/i, "루틴 변경"],
  [/^routine_delete$/i, "루틴 삭제"],
  [/^routine_/i, "루틴 관리"],
  [/^org_audit$/i, "봇 조직 점검"],
  [/^request_credentials$/i, "사이트 계정 입력 요청"],
  [/^memory_(save|create)$/i, "기억 저장"],
  [/^memory_(delete|remove)$/i, "기억 삭제"],
  [/^memory_/i, "기억 확인"],
  [/^skill_save$/i, "스킬 저장"],
  [/^skill_(delete|remove)$/i, "스킬 삭제"],
  [/^skill_/i, "스킬 관리"],
  [/^(shell_run|run_command|execute_command)$/i, "작업 폴더에서 명령 실행"],
  [/^(purchase|payment|pay|submit_payment)$/i, "결제 진행"],
  [/^(execute_sql|sql_execute)$/i, "데이터베이스 명령 실행"],
];

export function operationLabel(tool: string): string {
  const value = String(tool ?? "").trim();
  for (const [pattern, label] of TOOL_LABELS) if (pattern.test(value)) return label;
  return "연결된 서비스 작업";
}

const SECRET_KEY = /(^|_)(api_?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)($|_)/i;
const MASK = "[민감 정보 숨김]";

function maskSecrets(value: string): string {
  // 이미 마스킹된 문구의 공백을 비밀값 경계로 오인하지 않도록 처리 중에는
  // 공백 없는 센티널로 보호한다. 입력과 충돌하지 않는 값을 골라 반복 호출도
  // 동일한 결과를 내도록 한다.
  let sentinel = "\uE000MASKED_SECRET\uE001";
  while (value.includes(sentinel)) sentinel += "_";
  const protectedValue = value.split(MASK).join(sentinel);

  const masked = protectedValue
    // CLI 따옴표 값은 이스케이프된 따옴표와 여러 줄을 포함해 닫는 따옴표까지
    // 한 번에 가린다. 따옴표 자체는 남겨 명령의 구조와 나머지 대상을 보존한다.
    .replace(/(--(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:=|\s+))"(?:\\[\s\S]|[^"\\])*"/gi, `$1"${sentinel}"`)
    .replace(/(--(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:=|\s+))'(?:\\[\s\S]|[^'\\])*'/gi, `$1'${sentinel}'`)
    // JSON, 환경 변수 및 일반 key=value 형태도 같은 방식으로 처리한다.
    .replace(/((?:"|')?(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:"|')?\s*[:=]\s*)"(?:\\[\s\S]|[^"\\])*"/gi, `$1"${sentinel}"`)
    .replace(/((?:"|')?(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:"|')?\s*[:=]\s*)'(?:\\[\s\S]|[^'\\])*'/gi, `$1'${sentinel}'`)
    // Authorization: Bearer 값은 Bearer와 토큰을 하나의 비밀값으로 바꿔
    // 동일한 원본 비밀에 마스크가 중복 표시되지 않게 한다.
    // 따옴표로 시작하는 값은 위 규칙만 처리하며, fallback이 닫는 따옴표까지
    // 비밀값으로 삼지 않도록 양쪽 따옴표를 값 문자에서도 제외한다.
    .replace(/(--(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:=|\s+))(?!["'])(?:Bearer\s+)?[^\s,;&|"']+/gi, `$1${sentinel}`)
    .replace(/((?:"|')?(?:api[_-]?key|password|passwd|pass|secret|token|authorization|credential|cookie|session)(?:"|')?\s*[:=]\s*)(?!["'])(?:Bearer\s+)?[^\s,;&|"']+/gi, `$1${sentinel}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${sentinel}`)
    .replace(/(https?:\/\/[^\s/:]+:)[^@\s]+@/gi, `$1${sentinel}@`);

  return masked.split(sentinel).join(MASK);
}

function sanitizeValue(value: unknown, key = "", seen = new WeakSet<object>()): unknown {
  if (SECRET_KEY.test(key)) return MASK;
  if (typeof value === "string") return maskSecrets(value);
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (seen.has(value)) return "[순환 데이터 숨김]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, "", seen));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeValue(v, k, seen)]));
}

function text(value: unknown, max = 500): string {
  if (value === undefined || value === null) return "";
  const safe = sanitizeValue(value);
  const out = typeof safe === "string" ? safe : typeof safe === "object" ? JSON.stringify(safe) : String(safe);
  if (out.length <= max) return out;
  const marker = `… (${out.length - max}자 이상 생략)`;
  return `${out.slice(0, Math.max(0, max - marker.length))}${marker}`;
}

// 명령 원문처럼 사용자가 승인 전에 끝까지 확인해야 하는 값은 일반 사람용 필드의
// 500자 제한을 거치지 않는다. 비밀만 마스킹하고 나머지 원문은 생략 없이 보존한다.
function fullText(value: unknown): string {
  if (value === undefined || value === null) return "";
  const safe = sanitizeValue(value);
  if (typeof safe === "string") return safe;
  if (typeof safe === "object") return JSON.stringify(safe);
  return String(safe);
}

function firstFull(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (SECRET_KEY.test(key) || args[key] === undefined || args[key] === null || args[key] === "") continue;
    const value = fullText(args[key]);
    if (value) return value;
  }
  return "";
}

// 기본 승인 화면에는 임의 객체의 JSON을 펼치지 않는다. 객체는 아래의 알려진 도구별
// 스키마에서 의미 있는 필드만 골라 표시한다.
function humanValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return text(value);
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return text(v, 160);
      if (v && typeof v === "object" && !SECRET_KEY.test("name")) return text((v as Record<string, unknown>).name, 160);
      return "";
    }).filter(Boolean);
    return items.join(", ").slice(0, 500);
  }
  return "";
}

function first(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (SECRET_KEY.test(key) || args[key] === undefined || args[key] === null || args[key] === "") continue;
    const value = humanValue(args[key]);
    if (value) return value;
  }
  return "";
}

function add(details: ApprovalPresentation["details"], label: string, value: string) {
  if (value && value !== MASK && !details.some((d) => d.label === label && d.value === value)) details.push({ label, value });
}

function describeSchedule(schedule: string): string | null {
  const value = schedule.trim();
  let match = value.match(/^every:(\d+)m$/i);
  if (match && Number(match[1]) > 0) return `${Number(match[1])}분마다`;
  match = value.match(/^every:(\d+)h$/i);
  if (match && Number(match[1]) > 0) return `${Number(match[1])}시간마다`;
  match = value.match(/^daily:([01]\d|2[0-3]):([0-5]\d)$/i);
  if (match) return `매일 ${match[1]}:${match[2]}`;
  return null;
}

export function describeApproval(tool: string, args: Record<string, unknown>): ApprovalPresentation {
  const safeArgs = args ?? {};
  const title = operationLabel(tool);
  const details: ApprovalPresentation["details"] = [];
  const target = first(safeArgs, ["path", "file", "filename", "url", "target", "name", "app", "site", "table", "id"]);
  const recipient = first(safeArgs, ["to", "recipient", "recipients", "email", "chat_id"]);
  const amount = first(safeArgs, ["amount", "price", "total"]);
  const scope = first(safeArgs, ["scope", "range", "directory", "folder", "query", "filter"]);
  const before = first(safeArgs, ["before", "old", "old_value", "from"]);
  const after = first(safeArgs, ["after", "new", "new_value", "value"]);
  add(details, "대상", target);
  add(details, "받는 사람", recipient);
  add(details, "금액", amount);
  add(details, /delete|remove|drop/i.test(tool) ? "삭제 범위" : "적용 범위", scope);
  add(details, "변경 전", before);
  add(details, "변경 후", after);

  if (/^(send_email|mail_send)$/i.test(tool)) {
    add(details, "제목", first(safeArgs, ["subject", "title"]));
    return { title, summary: recipient ? `${recipient}에게 이메일을 보냅니다.` : "외부로 이메일을 보냅니다.", risk: "승인하면 메시지가 외부 수신자에게 실제로 전송됩니다.", details };
  }
  if (/telegram_send|send_telegram/i.test(tool))
    return { title, summary: recipient ? `${recipient}에게 메시지를 보냅니다.` : "외부 채널로 메시지를 보냅니다.", risk: "승인하면 메시지가 외부 채널에 실제로 전송됩니다.", details };
  if (/delete|remove|drop/i.test(tool))
    return { title, summary: target || scope ? `${target || scope} 항목을 삭제합니다.` : "선택된 항목을 삭제합니다.", risk: "삭제된 데이터는 복구하기 어렵거나 다른 작업에 영향을 줄 수 있습니다.", details };
  if (/purchase|payment|(^|_)pay(_|$)/i.test(tool))
    return { title, summary: amount ? `${amount} 결제를 진행합니다.` : "외부 서비스에서 결제를 진행합니다.", risk: "승인하면 실제 비용이 청구될 수 있습니다.", details };
  if (/^(shell_run|run_command|execute_command)$/i.test(tool)) {
    const command = firstFull(safeArgs, ["command", "cmd", "script"]);
    return {
      title,
      summary: "작업 폴더에서 셸 명령을 실행합니다.",
      risk: "셸 명령은 파일 변경이나 프로그램 실행 등 부작용이 있을 수 있으며, 화면에서 안전성을 확정할 수 없습니다.",
      details,
      technicalDetails: command || "명령 원문이 제공되지 않았습니다.",
    };
  }
  if (/^computer_type$/i.test(tool)) {
    add(details, "입력 위치", first(safeArgs, ["app", "target", "site"]));
    return { title, summary: "현재 화면의 입력란에 내용을 입력합니다.", risk: "입력 내용에는 민감한 정보가 포함될 수 있어 기본 화면에는 표시하지 않습니다.", details };
  }
  if (/^computer_/i.test(tool))
    return { title, summary: target ? `${target} 화면을 조작합니다.` : "현재 컴퓨터 화면을 조작합니다.", risk: "클릭이나 키 입력으로 앱 또는 외부 서비스의 상태가 바뀔 수 있습니다.", details };
  if (/^agent_create$/i.test(tool)) {
    const bots = Array.isArray(safeArgs.bots) ? safeArgs.bots : Array.isArray(safeArgs.agents) ? safeArgs.agents : [];
    const botDescriptions = bots.map((b) => {
      if (!b || typeof b !== "object") return text(b, 120);
      const row = b as Record<string, unknown>;
      const name = humanValue(row.name) || "이름 미지정";
      const role = humanValue(row.role);
      const model = humanValue(row.model);
      return `${name}${role ? ` — 역할: ${role}` : ""}${model ? ` — 모델: ${model}` : ""}`;
    }).filter(Boolean);
    if (botDescriptions.length) add(details, "생성할 봇", botDescriptions.join("\n"));
    else {
      add(details, "봇 이름", first(safeArgs, ["name", "bot_name", "agent"]));
      add(details, "역할", first(safeArgs, ["role", "persona"]));
      add(details, "모델", first(safeArgs, ["model"]));
    }
    add(details, "소속 팀장", first(safeArgs, ["parent", "under", "team"]));
    const names = botDescriptions.length ? botDescriptions.map((v) => v.split(" — ")[0]).join(", ") : first(safeArgs, ["name", "bot_name", "agent"]);
    return { title, summary: names ? `${names} 봇을 새로 만듭니다.` : "새 봇을 만듭니다.", risk: "새 봇이 이후 작업과 저장된 자원에 접근할 수 있습니다.", details };
  }
  if (/^agent_update$/i.test(tool)) {
    const agentTarget = first(safeArgs, ["name", "to", "agent", "target", "bot"]);
    add(details, "대상 봇", agentTarget);
    add(details, "새 이름", first(safeArgs, ["new_name"]));
    add(details, "새 역할", first(safeArgs, ["role"]));
    add(details, "새 모델", first(safeArgs, ["model"]));
    if (safeArgs.lead !== undefined) add(details, "팀장 여부", safeArgs.lead ? "팀장으로 지정" : "팀장 해제");
    if (safeArgs.max_children !== undefined) add(details, "하위 봇 한도", `${humanValue(safeArgs.max_children)}개`);
    if (safeArgs.parent !== undefined) add(details, "소속 변경", safeArgs.parent === "" || safeArgs.parent === null ? "CEO 직속" : humanValue(safeArgs.parent));
    return { title, summary: agentTarget ? `${agentTarget} 봇의 설정을 변경합니다.` : "봇 설정을 변경합니다.", risk: "변경 후 봇의 역할, 모델 또는 조직 내 권한 범위가 달라질 수 있습니다.", details };
  }
  if (/^(routine_add|routine_create)$/i.test(tool)) {
    const routineName = first(safeArgs, ["name"]);
    const trigger = first(safeArgs, ["trigger"]);
    const rawSchedule = firstFull(safeArgs, ["schedule", "every", "interval", "time", "cron"]);
    const schedule = rawSchedule ? describeSchedule(rawSchedule) : null;
    add(details, "루틴 이름", routineName);
    add(details, "실행 방식", trigger === "email" ? "이메일 수신 시" : "예약 실행");
    if (rawSchedule) add(details, "일정", schedule ?? "일정 형식 확인 필요");
    add(details, "메일 발신자 조건", first(safeArgs, ["email_from"]));
    add(details, "메일 제목 조건", first(safeArgs, ["email_subject"]));
    add(details, "실행할 작업", first(safeArgs, ["prompt", "task", "instruction", "content"]));
    return {
      title,
      summary: routineName ? `${routineName} 루틴을 등록합니다.` : "예약 또는 이메일 기반 루틴을 등록합니다.",
      risk: "승인 후 설정된 조건마다 작업이 반복 실행될 수 있습니다.",
      details,
      technicalDetails: rawSchedule && !schedule ? `일정 원문: ${rawSchedule}` : undefined,
    };
  }
  if (/^(read_file|file_read|write_file|file_write|edit_file|patch_file|replace_file|delete_file|remove_file)$/i.test(tool)) {
    const path = first(safeArgs, ["path", "file", "filename", "file_path"]);
    add(details, "파일", path);
    if (/write|edit|patch|replace/i.test(tool)) add(details, "변경 내용", first(safeArgs, ["content", "replacement", "after", "new_value"]));
    const changing = /write|edit|patch|replace|delete|remove/i.test(tool);
    return {
      title,
      summary: path ? `${path} 파일을 ${changing ? "변경합니다" : "읽습니다"}.` : `파일을 ${changing ? "변경합니다" : "읽습니다"}.`,
      risk: changing ? "파일 내용이 바뀌거나 삭제되어 다른 작업에 영향을 줄 수 있습니다." : "선택한 파일의 내용이 작업에 사용됩니다.",
      details,
    };
  }
  if (/^skill_save$/i.test(tool)) {
    add(details, "스킬 이름", first(safeArgs, ["name"]));
    add(details, "적용 조건", first(safeArgs, ["trigger"]));
    return { title, summary: "여러 봇이 다시 사용할 수 있는 작업 절차를 저장합니다.", risk: "저장된 절차는 이후 작업에서 반복 실행될 수 있습니다.", details, technicalDetails: text(safeArgs.steps, 4000) || undefined };
  }

  const likelyMcp = /mcp|::|\//i.test(tool) || !TOOL_LABELS.some(([pattern]) => pattern.test(tool));
  return {
    title,
    summary: target ? `${target}을(를) 대상으로 연결된 서비스 작업을 실행합니다.` : "연결된 서비스에서 작업을 실행합니다.",
    risk: likelyMcp ? "알 수 없는 연결 작업으로 실제 효과를 확인할 수 없습니다. 대상, 범위와 서비스 권한을 확인한 뒤 승인하세요." : "외부 서비스나 저장된 정보가 변경될 수 있습니다.",
    details,
  };
}

// 코드펜스 한 줄 — ```lang · ``` lang · ~~~lang · ````lang · 닫는 펜스를 모두 포함한다.
const FENCE_LINE = /^(`{3,}|~{3,})[ \t]*[\w+#.-]*[ \t]*$/;
const BARE_FENCE_LINE = /^(`{3,}|~{3,})[ \t]*$/;
// 모델이 코드펜스에 붙이는 언어 식별자. 펜스가 끊겨 언어명만 단독 줄로 남았을 때
// 걸러내는 데 쓴다 — 텔레그램 평문에 "markdown" 같은 태그가 그대로 전달된 사고의 경로다.
const FENCE_LANG_WORD = /^(json|jsonc|json5|xml|html|svg|css|scss|sass|less|markdown|md|mdx|yaml|yml|toml|ini|conf|cfg|env|csv|tsv|sql|mysql|pgsql|sqlite|graphql|gql|http|rest|text|txt|plain|plaintext|log|diff|patch|console|terminal|shell|sh|bash|zsh|fish|powershell|ps1|bat|cmd|js|jsx|mjs|cjs|javascript|ts|tsx|typescript|node|vue|svelte|astro|java|kotlin|kt|scala|groovy|c|h|cpp|cc|cxx|hpp|c\+\+|cs|csharp|fs|fsharp|vb|go|golang|rust|rs|ruby|rb|php|swift|objc|objective-c|r|lua|perl|pl|python|py|elixir|ex|exs|erlang|haskell|hs|clojure|clj|edn|lisp|scheme|racket|dart|julia|jl|nim|zig|crystal|reason|ocaml|ml|elm|solidity|wasm|wat|asm|verilog|vhdl|tcl|awk|sed|proto|protobuf|thrift|dockerfile|makefile|cmake|ninja|bazel|nginx|regex|latex|tex|pascal|fortran|cobol|ada|matlab|mermaid|plantuml|dot|sequence|flowchart|prisma|terraform|hcl|cue|jsonnet|gradle|docker|compose|output)$/i;

function cleanResult(content: string): string[] {
  const raw = String(content ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/\r/g, "");
  // 펜스는 줄 단위로 지운다 — "``` json"처럼 공백이 끼거나 "```\njson"처럼 언어가
  // 다음 줄로 밀린 형태, ~~~·4개 이상 백틱 펜스까지 정규식 하나로는 못 잡는다.
  const kept: string[] = [];
  let bareFence = false;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (FENCE_LINE.test(t)) { bareFence = BARE_FENCE_LINE.test(t); continue; }
    if (!t) { kept.push(line); continue; }
    // 언어 없는 펜스 바로 다음의 언어명 단독 줄은 펜스의 잔여물로 같이 지운다.
    if (bareFence && FENCE_LANG_WORD.test(t)) { bareFence = false; continue; }
    bareFence = false;
    kept.push(line);
  }
  // 본문 첫 콘텐츠 줄이 언어 라벨 하나뿐이면 펜스가 끊긴 잔여물과 같다고 본다.
  const firstContent = kept.findIndex((l) => l.trim());
  if (firstContent >= 0 && FENCE_LANG_WORD.test(kept[firstContent].trim())) kept.splice(firstContent, 1);
  const plain = kept.join("\n")
    // 다른 글자와 같은 줄에 섞인 펜스 잔여물도 걷어낸다.
    .replace(/(`{3,}|~{3,})[ \t]*[\w+#.-]*\n?/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ");
  const source = plain.split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim().replace(/^#{1,6}\s*/, ""))
    .filter(Boolean);
  const lines = source.flatMap((line) => {
    if (line.length <= 260) return [line];
    const chunks: string[] = [];
    for (let i = 0; i < line.length; i += 260) chunks.push(line.slice(i, i + 260));
    return chunks;
  });
  return [...new Set(lines)];
}

export function compactResult(content: string, maxChars = 1000): string {
  const limit = Math.max(1, Math.floor(maxChars || 1000));
  const lines = cleanResult(content);
  if (!lines.length) return "결과 내용이 없습니다.".slice(0, limit);
  const warningRe = /(실패|오류|에러|부분 결과|부분 완료|중단|미완료|남은 작업|미확인|미검증|확인하지 못|검증하지 못|불확실|주의|조치 필요|해야 합니다|필요합니다|다시 시도|권한|취소|거부|action required|partial|unverified|interrupted)/i;
  const chatterRe = /^(알겠습니다|요청하신 작업을 시작|작업을 시작|진행하겠습니다|확인해 보겠습니다)[.!… ]*$/i;
  const important = lines.filter((line) => warningRe.test(line));
  const lead = lines.filter((line) => !chatterRe.test(line) && (!important.length || !/^(완료|성공|모두 처리)/.test(line))).slice(0, important.length ? 1 : 3);
  const selected: string[] = [];
  for (const line of [...important, ...lead]) if (!selected.includes(line)) selected.push(line);
  let out = "";
  for (const line of selected) {
    const next = out ? `${out}\n${line}` : line;
    if (next.length <= limit) out = next;
    else if (!out) out = line.slice(0, limit);
    else if (important.includes(line)) {
      const suffix = `\n${line}`.slice(0, limit);
      out = `${out.slice(0, Math.max(0, limit - suffix.length - 1))}…${suffix}`.slice(0, limit);
    }
  }
  const omitted = lines.filter((line) => !selected.includes(line)).join("\n").length;
  const note = omitted ? `\n(${omitted}자 이상 생략 · 전체 결과 보기)` : "";
  if (note && out.length + note.length <= limit) out += note;
  return out.slice(0, limit) || "결과 내용이 없습니다.".slice(0, limit);
}
