import { describe, expect, test } from "bun:test";
import { compactResult, describeApproval, operationLabel } from "../../shared/user-facing";

describe("사용자용 작업 설명", () => {
  test("도구 식별자와 필드 키를 직접 노출하지 않는다", () => {
    expect(operationLabel("shell_run")).toBe("작업 폴더에서 명령 실행");
    expect(operationLabel("vendor_private_action")).toBe("연결된 서비스 작업");
    const shown = JSON.stringify(describeApproval("vendor_private_action", { target: "문서 A" }));
    expect(shown).not.toContain("vendor_private_action");
    expect(shown).not.toContain('"target"');
  });

  test("알 수 없는 명령과 삭제를 안전하다고 추정하지 않는다", () => {
    expect(describeApproval("shell_run", { command: "node deploy.js" }).risk).toContain("파일 변경이나 프로그램 실행");
    expect(describeApproval("delete_file", { path: "보고서" }).risk).toContain("복구");
  });

  test("어떤 셸 명령도 확인된 단순 조회라고 표시하지 않는다", () => {
    const commands = [
      "find . -delete",
      "awk 'BEGIN { system(\"touch changed\") }'",
      "grep --pre='rm -rf .' pattern file",
      "git -c core.pager='sh -c touch changed' status",
      "cat input | tee changed",
      "ls\ntouch changed",
      "pwd",
    ];
    for (const command of commands) {
      const shown = describeApproval("shell_run", { command });
      expect(shown.risk).toContain("안전성을 확정할 수 없습니다");
      expect(shown.risk).not.toContain("단순 조회");
    }
  });

  test("수신자와 대상은 보존하고 비밀은 마스킹한다", () => {
    const mail = describeApproval("send_email", { to: "person@example.com", subject: "안내" });
    expect(JSON.stringify(mail)).toContain("person@example.com");
    const shell = describeApproval("shell_run", { command: "curl -H 'Authorization: Bearer abc.def' https://example.com", token: "never-show" });
    expect(shell.technicalDetails).toContain("민감 정보 숨김");
    expect(JSON.stringify(shell)).not.toContain("abc.def");
    expect(JSON.stringify(shell)).not.toContain("never-show");
  });

  test("중첩 객체, 배열, 공백이 든 따옴표 CLI 비밀을 재귀적으로 숨긴다", () => {
    const shell = describeApproval("shell_run", {
      command: `tool --password "secret with spaces" --token='another secret' --data '{"password":"json secret"}'`,
      config: { nested: [{ password: "array-secret" }, { authorization: "Bearer hidden" }] },
    });
    const shown = JSON.stringify(shell);
    for (const secret of ["secret with spaces", "another secret", "json secret", "array-secret", "Bearer hidden"])
      expect(shown).not.toContain(secret);
    expect(shown).toContain("민감 정보 숨김");
  });

  test("여러 줄 따옴표 비밀값을 명령 세부 내용에서도 숨긴다", () => {
    const shell = describeApproval("shell_run", {
      command: `tool --password "first secret line\nsecond secret line" --token='third secret\nfourth secret'`,
    });
    const shown = JSON.stringify(shell);
    for (const secret of ["first secret line", "second secret line", "third secret", "fourth secret"])
      expect(shown).not.toContain(secret);
    expect(shown).toContain("민감 정보 숨김");
  });

  test("마스킹은 반복 적용해도 안정적이며 원본 비밀 하나당 한 번만 표시한다", () => {
    const command = `echo "preview workspace" --token="FAKE secret" --target production`;
    const expected = `echo "preview workspace" --token="[민감 정보 숨김]" --target production`;
    const once = describeApproval("shell_run", { command });
    expect(once.technicalDetails).toBe(expected);
    expect(once.technicalDetails).not.toContain("FAKE secret");
    expect(once.technicalDetails?.match(/\[민감 정보 숨김\]/g)?.length).toBe(1);

    const twice = describeApproval("shell_run", { command: once.technicalDetails });
    expect(twice.technicalDetails).toBe(expected);
    expect(twice.technicalDetails?.match(/\[민감 정보 숨김\]/g)?.length).toBe(1);

    const alreadyMasked = describeApproval("shell_run", { command: `echo ready --token=[민감 정보 숨김] --target workspace` });
    expect(alreadyMasked.technicalDetails).toBe(`echo ready --token=[민감 정보 숨김] --target workspace`);
  });

  test("equals, Bearer, 내장 JSON과 이스케이프된 따옴표의 비밀을 경계까지 숨긴다", () => {
    const command = `tool token=plain --password="first \\"quoted\\" secret" -H 'Authorization: Bearer abc.def' --data '{"items":[{"password":"json one"},{"token":"json two"}]}' --target preview-workspace`;
    const shell = describeApproval("shell_run", { command });
    const shown = shell.technicalDetails ?? "";
    for (const secret of ["plain", "first", "quoted", "secret", "abc.def", "json one", "json two"])
      expect(shown).not.toContain(secret);
    expect(shown).toContain("--target preview-workspace");
    expect(shown.match(/\[민감 정보 숨김\]/g)?.length).toBe(5);
  });

  test("중첩 배열의 비밀 키를 기술 세부 내용에서 재귀적으로 숨긴다", () => {
    const skill = describeApproval("skill_save", {
      steps: [{ action: "login", config: [{ password: "nested-one" }, { token: "nested-two" }] }],
    });
    expect(skill.technicalDetails).not.toContain("nested-one");
    expect(skill.technicalDetails).not.toContain("nested-two");
    expect(skill.technicalDetails?.match(/\[민감 정보 숨김\]/g)?.length).toBe(2);
  });

  test("긴 셸 명령을 중간 생략 없이 끝까지 그대로 보존한다", () => {
    const command = `echo ${"가".repeat(2200)}; destructive-tail`;
    const shell = describeApproval("shell_run", { command });
    expect(shell.technicalDetails).toBe(command);
    expect(shell.technicalDetails).toContain("가".repeat(2100));
    expect(shell.technicalDetails).toContain("destructive-tail");
    expect(shell.technicalDetails).not.toContain("중간 생략");
  });

  test("알려진 조직·루틴 스키마만 사람용 필드로 설명한다", () => {
    const update = describeApproval("agent_update", { name: "분석봇", new_name: "리서치봇", role: "시장 조사", model: "provider/model", lead: true, max_children: 3 });
    expect(JSON.stringify(update.details)).toContain("리서치봇");
    expect(JSON.stringify(update.details)).toContain("팀장으로 지정");
    const create = describeApproval("agent_create", { bots: [{ name: "메일봇", role: "메일 분석", password: "do-not-show" }] });
    expect(JSON.stringify(create)).toContain("메일봇");
    expect(JSON.stringify(create)).not.toContain("do-not-show");
    const routine = describeApproval("routine_add", { name: "아침 브리핑", schedule: "daily:08:00", prompt: "오늘 뉴스를 조사해 보고" });
    expect(JSON.stringify(routine.details)).toContain("매일 08:00");
    expect(JSON.stringify(routine.details)).not.toContain("daily:08:00");
    expect(JSON.stringify(routine)).toContain("오늘 뉴스를 조사해 보고");
  });

  test("지원하는 반복 일정을 번역하고 알 수 없는 일정 원문은 기술 세부에만 둔다", () => {
    expect(JSON.stringify(describeApproval("routine_add", { schedule: "every:30m" }).details)).toContain("30분마다");
    expect(JSON.stringify(describeApproval("routine_add", { schedule: "every:2h" }).details)).toContain("2시간마다");

    const unknown = describeApproval("routine_add", { schedule: "0 8 * * *" });
    expect(JSON.stringify(unknown.details)).toContain("일정 형식 확인 필요");
    expect(JSON.stringify(unknown.details)).not.toContain("0 8 * * *");
    expect(unknown.technicalDetails).toContain("0 8 * * *");
  });

  test("파일 작업 문장을 자연스러운 한국어로 표시한다", () => {
    expect(describeApproval("write_file", { path: "보고서.md" }).summary).toBe("보고서.md 파일을 변경합니다.");
    expect(describeApproval("read_file", { path: "보고서.md" }).summary).toBe("보고서.md 파일을 읽습니다.");
  });

  test("알 수 없는 플러그인 작업은 효과를 모른다고 경고한다", () => {
    expect(describeApproval("vendor_private_action", { target: "문서 A", nested: { arbitrary: "raw-json" } }).risk).toContain("실제 효과를 확인할 수 없습니다");
    expect(JSON.stringify(describeApproval("vendor_private_action", { nested: { arbitrary: "raw-json" } }))).not.toContain("raw-json");
  });
});

describe("결과 축약", () => {
  test("길이 상한과 긴 한 줄을 처리한다", () => {
    const result = compactResult(`시작-${"가".repeat(5000)}-끝`, 120);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.startsWith("시작-가")).toBe(true);
  });

  test("뒤쪽 실패와 사용자 조치를 보존한다", () => {
    const result = compactResult(`${"진행 내용\n".repeat(100)}실패: 권한이 없습니다\n사용자 조치 필요: 관리자의 권한을 확인하세요`, 180);
    expect(result).toContain("실패");
    expect(result).toContain("사용자 조치");
  });

  test("서론보다 부분·미검증·중단 경고를 우선하고 완료로 오도하지 않는다", () => {
    const result = compactResult(`${"알겠습니다\n".repeat(40)}완료했습니다\n부분 결과: 10건 중 2건만 확인\n미검증: 외부 시스템 응답 없음\n남은 작업: 관리자 조치 필요`, 180);
    expect(result).toContain("부분 결과");
    expect(result).toContain("미검증");
    expect(result).toContain("조치 필요");
    expect(result).not.toBe("완료했습니다");
  });

  test("요약에서만 마크다운 제목과 코드 펜스를 걷어낸다", () => {
    const original = "## 결과\n```text\n실패: 권한 필요\n```";
    const result = compactResult(original, 200);
    expect(result).toContain("결과");
    expect(result).toContain("실패: 권한 필요");
    expect(result).not.toContain("```");
    expect(original).toContain("## 결과");
  });

  test("빈 결과에 안내를 제공한다", () => {
    expect(compactResult("   \n```\n```", 100)).toBe("결과 내용이 없습니다.");
  });

  test("코드펜스 언어 태그가 어떤 형태로 와도 전송 문구에 남지 않는다", () => {
    for (const lang of ["markdown", "typescript", "json", "bash", "python"]) {
      const result = compactResult(`## 요약\n\`\`\`${lang}\n내용입니다\n\`\`\``, 500);
      expect(result).toContain("내용입니다");
      expect(result).not.toContain(lang);
      expect(result).not.toContain("```");
    }
  });

  test("공백·줄바꿈으로 끊긴 펜스와 물결표·4개 백틱 펜스의 언어 태그도 지운다", () => {
    for (const raw of [
      "``` json\n내용입니다\n```",
      "```\njson\n내용입니다\n```",
      "```\n\nmarkdown\n내용입니다\n```",
      "~~~typescript\n내용입니다\n~~~",
      "````markdown\n내용입니다\n````",
      "```c++\n내용입니다\n```",
    ]) {
      const result = compactResult(`도입 문장\n${raw}\n마무리 문장`, 500);
      expect(result).toContain("내용입니다");
      expect(result).not.toContain("```");
      expect(result).not.toContain("~~~");
      expect(result).not.toMatch(/^(json|markdown|typescript|c\+\+)$/im);
    }
  });

  test("본문 첫 줄의 언어 라벨만 지우고 일반 문장의 언어 언급은 보존한다", () => {
    const labeled = compactResult("markdown\n## 요약\n내용입니다", 500);
    expect(labeled).not.toMatch(/^markdown$/m);
    expect(labeled).toContain("내용입니다");
    const normal = compactResult("JSON 형식으로 저장했습니다\nTypeScript 파일을 수정했습니다", 500);
    expect(normal).toContain("JSON 형식");
    expect(normal).toContain("TypeScript 파일");
  });

  test("섹션 제목은 내용과 함께 나가고 빈 제목은 전송하지 않는다", () => {
    // 실제 사고 재현 — 브리핑 보고서에서 경고 키워드에 걸린 줄과 빈 제목만 나갔다
    const md = [
      "## 오늘의 핵심",
      "- 코스피 장중 회복 — 수급 지속성이 관건입니다.",
      "- 무역협상대표 위상 격상 — 협상 준비 움직임입니다.",
      "",
      "## 업무 관련성",
      "- 정책을 확인한 뒤 판단해야 합니다.",
      "",
      "## 미확인·한계",
      "- 개별 기사 본문은 열람하지 못했습니다.",
      "## 내용 없는 섹션",
      "## 마지막",
      "- 보통 내용입니다.",
    ].join("\n");
    const result = compactResult(md, 1000);
    // 핵심 뉴스가 생략되지 않고 섹션과 함께 나간다
    expect(result).toContain("오늘의 핵심");
    expect(result).toContain("코스피 장중 회복");
    expect(result).toContain("무역협상대표");
    // 제한사항도 제목과 함께 나간다
    expect(result).toContain("미확인·한계");
    expect(result).toContain("열람하지 못했습니다");
    // 내용 없는 섹션 제목은 단독으로 나가지 않는다
    expect(result).not.toContain("내용 없는 섹션");
  });

  test("경고가 있으면 완료 선언은 앞세우지 않는다", () => {
    const md = "## 요약\n완료했습니다\n\n## 미확인\n- 일부는 확인하지 못했습니다";
    const result = compactResult(md, 300);
    expect(result).toContain("확인하지 못했습니다");
    expect(result).not.toContain("완료했습니다");
  });

  test("오류의 원시 JSON 덩어리는 읽을 수 있는 문구로 정리한다", () => {
    // 잘린 JSON — 덩어리째 제거
    const truncated = compactResult("- 하위 작업 실패: 에이전트 오류: 오류 400: {\"contentFilter\":[{\"level\":1,\"role\":\"assistant\"}],\"error\":{\"code\":\"1301\",\"message\":\"System detected potenti", 500);
    expect(truncated).not.toContain("{");
    expect(truncated).toContain("하위 작업 실패");
    // 완전한 JSON — error.message만 남긴다
    const complete = compactResult("- 작업 실패: 오류 500: {\"error\":{\"code\":\"500\",\"message\":\"internal timeout\"}}", 500);
    expect(complete).toContain("internal timeout");
    expect(complete).not.toContain("code");
    // 오류가 아닌 줄의 JSON 콘텐츠는 보존한다
    const normal = compactResult("설정값 {\"retry\": 3} 적용했습니다", 500);
    expect(normal).toContain("{\"retry\": 3}");
  });
});
