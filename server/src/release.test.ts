import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, setSetting } from "./db";
import {
  evaluateRelease, runGates, defaultGates, bootCheck, run, BUN,
  writeReceipt, readReceipts, interruptedReceipt, type Gate,
  classifyTier, nextVersion, pickWinbackTarget, applyRelease, createReleaseManager, type Receipt, type ReleaseRecord,
} from "./release";

if (db.filename !== ":memory:") throw new Error(`테스트가 운영 DB를 열었습니다: ${db.filename}`);

// 릴리스 적용은 실서비스의 코드를 통째로 바꾸고 재시작까지 한다.
// 어떤 상태에서 버튼이 열리는지를 테스트로 고정해 둔다.

const ok = { hasChannel: true, pending: 2, clean: true, ff: true };

test("검증된 커밋이 대기 중이고 작업 폴더가 깨끗하면 적용할 수 있다", () => {
  expect(evaluateRelease(ok)).toEqual({ canApply: true, reason: "" });
});

test("release 브랜치가 아직 없으면 적용할 수 없다", () => {
  const r = evaluateRelease({ ...ok, hasChannel: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("아직 없습니다");
});

test("대기 중인 커밋이 없으면 최신 상태로 알린다", () => {
  const r = evaluateRelease({ ...ok, pending: 0 });
  expect(r.canApply).toBe(false);
  expect(r.reason).toBe("최신 상태입니다");
});

test("서비스 폴더에 커밋되지 않은 변경이 있으면 적용하지 않는다", () => {
  // 적용 실패 시 reset --hard로 되돌리므로, 남아 있는 변경은 그때 사라진다
  const r = evaluateRelease({ ...ok, clean: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("커밋되지 않은 변경");
});

test("release가 갈라져 있으면 자동으로 합치지 않고 사람에게 넘긴다", () => {
  const r = evaluateRelease({ ...ok, ff: false });
  expect(r.canApply).toBe(false);
  expect(r.reason).toContain("갈라져");
});

// --- 검증 게이트: 실패를 주입해 멈추는지 본다 (개선지침서 R2) ---

const gate = (name: string, ok: boolean, log: string[]): Gate =>
  ({ name, run: async () => { log.push(name); return { ok, out: ok ? "" : `${name} 실패` }; } });

test("모든 단계를 통과하면 적용을 진행한다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", true, log), gate("웹 빌드", true, log)]);
  expect(r.ok).toBe(true);
  expect(log).toEqual(["테스트", "웹 빌드"]);
});

test("한 단계가 실패하면 거기서 멈추고 뒤 단계를 돌리지 않는다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", false, log), gate("웹 빌드", true, log), gate("기동 시험", true, log)]);
  expect(r.ok).toBe(false);
  if (!r.ok) { expect(r.stage).toBe("테스트"); expect(r.out).toContain("실패"); }
  expect(log).toEqual(["테스트"]); // 깨진 코드로 빌드·기동을 시도하지 않는다
});

test("마지막 단계의 실패도 놓치지 않는다", async () => {
  const log: string[] = [];
  const r = await runGates([gate("테스트", true, log), gate("기동 시험", false, log)]);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.stage).toBe("기동 시험");
  expect(log).toEqual(["테스트", "기동 시험"]);
});

// 2026-09-19 회귀: launchd로 뜬 서버가 "bun"을 PATH에서 찾지 못해 spawn이 예외를 던졌고,
// 그 예외가 롤백을 건너뛰어 병합만 된 채 재시작도 되돌리기도 없이 HTTP 500만 남았다.

test("하위 명령은 PATH가 아니라 지금 돌고 있는 실행 파일로 부른다", () => {
  expect(BUN.startsWith("/")).toBe(true);
  // 게이트가 "bun"을 이름으로 부르면 launchd 환경에서 다시 같은 사고가 난다
  expect(BUN).not.toBe("bun");
});

test("실행 파일을 찾지 못해도 예외 대신 실패로 돌려준다", () => {
  const r = run(["/nonexistent/definitely-not-here"], {});
  expect(r.ok).toBe(false);
  expect(r.out).toContain("실행할 수 없습니다");
});

test("기동 시험은 뜨지 못하는 코드를 잡아낸다", async () => {
  // 이 단계가 없으면 기동 실패 코드가 그대로 배포되고, launchd가 무한 재시작을 돌아
  // 화면이 죽은 탓에 되돌리기조차 누를 수 없게 된다
  const dir = mkdtempSync(join(tmpdir(), "mybot-boot-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), 'throw new Error("기동 실패 주입");\n');
    const r = await bootCheck(dir);
    expect(r.ok).toBe(false);
    expect(r.out).toContain("종료");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test("기동 시험은 웹 빌드까지 끝난 뒤 마지막에 돌린다", () => {
  // 순서가 바뀌면 빌드 전 코드로 띄우게 되어 실제 배포본을 검증하지 못한다
  const names = defaultGates().map((g) => g.name);
  expect(names).toEqual(["테스트", "타입검사", "웹 빌드", "기동 시험"]);
});

// 2026-09-20 사고: merge로 서비스 트리를 바꾼 뒤 돌린 스위트가 외장 디스크 I/O 경합으로
// 샌드박스 계열 테스트를 떨궈 멀쩡한 업데이트가 롤백됐다. 이제 검증은 대상 커밋을
// 임시 worktree(빠른 로컬 디스크)에서 끝내고, 통과한 트리만 merge한다.

test("검증 게이트는 지정한 루트 안에서 실행된다 — 스테이징 worktree가 쓰는 형태", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mybot-gates-"));
  try {
    mkdirSync(join(dir, "server"));
    // 이 루트에서 도는 게 맞다면 실패해야 한다 — 저장소 테스트를 돌렸으면 통과했을 것
    writeFileSync(join(dir, "server", "x.test.ts"), 'import { test, expect } from "bun:test"; test("f", () => expect(1).toBe(2));');
    const r = await defaultGates(dir)[0].run();
    expect(r.ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);

test("이전 적용이 끝나지 않았으면 새 적용을 겹쳐 돌리지 않는다", async () => {
  setSetting("release_inflight", JSON.stringify({ from: "a", to: "b", subjects: [], ts: Date.now() }));
  try {
    const r = await applyRelease([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("끝나지 않았습니다");
  } finally { setSetting("release_inflight", ""); }
});

// --- 불변 대상 SHA·활성화 펜스 ---
// 실제 체크아웃과 DB를 절대 건드리지 않는다. 각 사례는 폐기 가능한 git 저장소와
// 메모리 settings/receipts만 사용해 비동기 검증 중 외부 변화까지 재현한다.

function gitAt(root: string, ...args: string[]) {
  return run(["git", ...args], { cwd: root });
}

function mustGit(root: string, ...args: string[]): string {
  const result = gitAt(root, ...args);
  if (!result.ok) throw new Error(`git ${args.join(" ")} 실패: ${result.out}`);
  return result.out.trim();
}

function releaseRepo() {
  const root = mkdtempSync(join(tmpdir(), "mybot-release-repo-"));
  mustGit(root, "init", "-b", "main");
  mustGit(root, "config", "user.email", "release-test@example.invalid");
  mustGit(root, "config", "user.name", "Release Test");
  writeFileSync(join(root, "state.txt"), "A\n");
  mustGit(root, "add", "state.txt");
  mustGit(root, "commit", "-m", "기준 A");
  const before = mustGit(root, "rev-parse", "HEAD");

  mustGit(root, "checkout", "-b", "release");
  writeFileSync(join(root, "state.txt"), "B\n");
  mustGit(root, "commit", "-am", "긴급: 대상 B");
  const target = mustGit(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "state.txt"), "C\n");
  mustGit(root, "commit", "-am", "긴급: 다음 C");
  const next = mustGit(root, "rev-parse", "HEAD");
  mustGit(root, "checkout", "main");
  mustGit(root, "update-ref", "refs/heads/release", target);
  return { root, before, target, next };
}

function isolatedManager(root: string, overrides: Parameters<typeof createReleaseManager>[0] = {}) {
  const settings = new Map<string, string>();
  const receipts: Receipt[] = [];
  const manager = createReleaseManager({
    root,
    git: (...args) => gitAt(root, ...args),
    // Git 이외의 실제 명령은 허용하지 않는다. install/build/boot는 아래의 기록 가능한
    // 스텁으로만 실행돼 폐기 저장소 밖 프로세스나 네트워크에 닿지 않는다.
    run: () => ({ ok: true, out: "" }),
    getSetting: (key) => settings.get(key) ?? null,
    setSetting: (key, value) => { settings.set(key, value); },
    writeReceipt: (receipt) => { receipts.push(receipt); },
    installDeps: () => ({ ok: true, out: "" }),
    buildWeb: () => ({ ok: true, out: "" }),
    bootCheck: async () => ({ ok: true, out: "" }),
    defaultGates: () => [],
    deployGates: () => [],
    ...overrides,
  });
  return { manager, settings, receipts };
}

test("검증 중 release가 B에서 C로 움직여도 캡처한 B만 적용하고 C는 대기로 남긴다", async () => {
  const repo = releaseRepo();
  try {
    let stageDir = "";
    let stagedHead = "";
    let stagedState = "";
    let journalTarget = "";
    const gitCalls: string[][] = [];
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      git: (...args) => { gitCalls.push(args); return gitAt(repo.root, ...args); },
      makeStageDir: () => {
        stageDir = mkdtempSync(join(tmpdir(), "mybot-release-stage-test-"));
        return stageDir;
      },
    });
    const result = await manager.applyRelease([{
      name: "경쟁 조건 주입",
      run: async () => {
        stagedHead = mustGit(stageDir, "rev-parse", "HEAD");
        stagedState = readFileSync(join(stageDir, "state.txt"), "utf8");
        journalTarget = JSON.parse(settings.get("release_inflight") || "{}").to ?? "";
        mustGit(repo.root, "update-ref", "refs/heads/release", repo.next);
        return { ok: true, out: "" };
      },
    }]);

    expect(result.ok).toBe(true);
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.target);
    expect(mustGit(repo.root, "rev-parse", "refs/heads/release")).toBe(repo.next);
    expect(stagedHead).toBe(repo.target);
    expect(stagedState).toBe("B\n");
    expect(journalTarget).toBe(repo.target);
    expect(gitCalls).toContainEqual(["worktree", "add", "--detach", stageDir, repo.target]);
    expect(gitCalls).toContainEqual(["merge", "--ff-only", repo.target]);
    expect(mustGit(repo.root, "rev-parse", "v0.0.1")).toBe(repo.target);
    const history = JSON.parse(settings.get("release_history") || "[]") as ReleaseRecord[];
    expect(history.at(-1)?.sha).toBe(repo.target);
    expect(history.at(-1)?.subjects).toEqual(["긴급: 대상 B"]);
    expect(receipts.at(-1)).toEqual(expect.objectContaining({ result: "applied", to: repo.target }));
    expect(receipts.at(-1)?.subjects).toEqual(["긴급: 대상 B"]);
    expect(mustGit(repo.root, "log", "--format=%s", "HEAD..release")).toBe("긴급: 다음 C");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("검증 중 live HEAD가 바뀌면 외부 커밋을 보존하고 활성화를 거부한다", async () => {
  const repo = releaseRepo();
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root);
    let external = "";
    const result = await manager.applyRelease([{
      name: "HEAD 변경 주입",
      run: async () => {
        writeFileSync(join(repo.root, "external.txt"), "외부 변경\n");
        mustGit(repo.root, "add", "external.txt");
        mustGit(repo.root, "commit", "-m", "외부 커밋");
        external = mustGit(repo.root, "rev-parse", "HEAD");
        return { ok: true, out: "" };
      },
    }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("현재 커밋이 바뀌었습니다");
      expect(result.error).toContain("외부 변경을 그대로 보존");
    }
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(external);
    expect(readFileSync(join(repo.root, "external.txt"), "utf8")).toBe("외부 변경\n");
    expect(settings.get("release_inflight")).toBe("");
    expect(receipts.at(-1)?.result).toBe("rejected");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("검증 중 추적 파일이 바뀌면 내용을 보존하고 활성화를 거부한다", async () => {
  const repo = releaseRepo();
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root);
    const result = await manager.applyRelease([{
      name: "dirty 변경 주입",
      run: async () => {
        writeFileSync(join(repo.root, "state.txt"), "외부 dirty 변경\n");
        return { ok: true, out: "" };
      },
    }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("추적 변경이 생겼습니다");
      expect(result.error).toContain("외부 변경을 그대로 보존");
    }
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.before);
    expect(readFileSync(join(repo.root, "state.txt"), "utf8")).toBe("외부 dirty 변경\n");
    expect(settings.get("release_inflight")).toBe("");
    expect(receipts.at(-1)?.result).toBe("rejected");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("merge 뒤 외부 커밋과 dirty 변경이 생기면 지우지 않고 수동 확인 상태로 남긴다", async () => {
  const repo = releaseRepo();
  try {
    let externalHead = "";
    const injectedGit = (...args: string[]) => {
      const result = gitAt(repo.root, ...args);
      if (args[0] === "merge" && result.ok) {
        writeFileSync(join(repo.root, "external.txt"), "외부 커밋\n");
        mustGit(repo.root, "add", "external.txt");
        mustGit(repo.root, "commit", "-m", "병합 뒤 외부 커밋");
        externalHead = mustGit(repo.root, "rev-parse", "HEAD");
        writeFileSync(join(repo.root, "state.txt"), "병합 뒤 dirty 변경\n");
      }
      return result;
    };
    const { manager, settings, receipts } = isolatedManager(repo.root, { git: injectedGit });
    const result = await manager.applyRelease([]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("활성화된 커밋이 검증 대상과 다릅니다");
      expect(result.error).toContain("현재 상태를 보존");
    }
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(externalHead);
    expect(readFileSync(join(repo.root, "external.txt"), "utf8")).toBe("외부 커밋\n");
    expect(readFileSync(join(repo.root, "state.txt"), "utf8")).toBe("병합 뒤 dirty 변경\n");
    expect(settings.get("release_inflight")).toContain(repo.target);
    expect(settings.get("release_history")).toBeUndefined();
    expect(receipts.at(-1)?.result).toBe("recovery-failed");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("활성화 성공 뒤 스테이지 정리 예외가 성공 결과와 재시작 경로를 뒤집지 않는다", async () => {
  const repo = releaseRepo();
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      removeStageDir: () => { throw new Error("정리 실패 주입"); },
    });
    const result = await manager.applyRelease([]);

    expect(result.ok).toBe(true);
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.target);
    expect(settings.get("release_inflight")).toBe("");
    expect(settings.get("release_history")).toContain(repo.target);
    expect(receipts.at(-1)?.result).toBe("applied");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("게이트 팩토리 예외도 스테이지와 저널을 정리하고 거부 영수증을 남긴다", async () => {
  const repo = releaseRepo();
  let stageDir = "";
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      makeStageDir: () => {
        stageDir = mkdtempSync(join(tmpdir(), "mybot-release-stage-throw-"));
        return stageDir;
      },
      defaultGates: () => { throw new Error("게이트 팩토리 실패 주입"); },
    });
    const result = await manager.applyRelease();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("게이트 팩토리 실패 주입");
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.before);
    expect(settings.get("release_inflight")).toBe("");
    expect(receipts.at(-1)?.result).toBe("rejected");
    expect(existsSync(stageDir)).toBe(false);
  } finally {
    if (stageDir) rmSync(stageDir, { recursive: true, force: true });
    rmSync(repo.root, { recursive: true, force: true });
  }
}, 30000);

// --- 소유권 저널·검증된 복구·윈백 보상 ---

test("반영 뒤 실패는 이전 SHA의 의존성·빌드·기동·clean까지 확인해야 rolled-back이다", async () => {
  const repo = releaseRepo();
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      deployGates: () => [{ name: "반영 실패 주입", run: async () => ({ ok: false, out: "반영 실패" }) }],
    });
    const result = await manager.applyRelease([]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("의존성·빌드·기동·작업 폴더까지 검증");
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.before);
    expect(mustGit(repo.root, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(settings.get("release_inflight")).toBe("");
    expect(receipts.at(-1)?.result).toBe("rolled-back");
    expect(receipts.at(-1)?.error).toContain("복구를 모두 검증");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("복구 reset·루트 install·웹 install·build·boot 중 하나라도 실패하면 recovery-required를 유지한다", async () => {
  const cases = ["reset", "root-install", "web-install", "build", "boot"] as const;
  for (const failure of cases) {
    const repo = releaseRepo();
    try {
      let rootInstalls = 0;
      let webInstalls = 0;
      const overrides: Parameters<typeof createReleaseManager>[0] = {
        deployGates: () => [{ name: "반영 실패 주입", run: async () => ({ ok: false, out: "반영 실패" }) }],
        git: (...args) => {
          if (failure === "reset" && args[0] === "reset" && args[1] === "--hard" && args[2] === repo.before)
            return { ok: false, out: "reset 실패 주입" };
          return gitAt(repo.root, ...args);
        },
        installDeps: (dir) => {
          if (dir === repo.root && ++rootInstalls === 2 && failure === "root-install") return { ok: false, out: "root install 실패 주입" };
          if (dir === join(repo.root, "web") && ++webInstalls === 2 && failure === "web-install") return { ok: false, out: "web install 실패 주입" };
          return { ok: true, out: "" };
        },
        buildWeb: () => failure === "build" ? { ok: false, out: "build 실패 주입" } : { ok: true, out: "" },
        bootCheck: async () => failure === "boot" ? { ok: false, out: "boot 실패 주입" } : { ok: true, out: "" },
      };
      const { manager, settings, receipts } = isolatedManager(repo.root, overrides);
      const result = await manager.applyRelease([]);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("서비스 파일 상태는 확인되지 않았");
        expect(result.error).not.toContain("상태로 되돌린 뒤");
      }
      const journal = JSON.parse(settings.get("release_inflight") || "{}") as { phase?: string; owner?: string };
      expect(journal.phase).toBe("recovery-required");
      expect(journal.owner).toBeTruthy();
      expect(receipts.at(-1)?.result).toBe("recovery-failed");
      expect(receipts.at(-1)?.error).toContain("실패");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  }
}, 60000);

test("복구 install·build·boot가 예외를 던져도 recovery-failed로 닫힌다", async () => {
  const cases = ["install", "build", "boot"] as const;
  for (const failure of cases) {
    const repo = releaseRepo();
    try {
      let rootInstalls = 0;
      const { manager, settings, receipts } = isolatedManager(repo.root, {
        deployGates: () => [{ name: "반영 실패 주입", run: async () => ({ ok: false, out: "반영 실패" }) }],
        installDeps: (dir) => {
          if (failure === "install" && dir === repo.root && ++rootInstalls === 2) throw new Error("install throw 주입");
          return { ok: true, out: "" };
        },
        buildWeb: () => { if (failure === "build") throw new Error("build throw 주입"); return { ok: true, out: "" }; },
        bootCheck: async () => { if (failure === "boot") throw new Error("boot throw 주입"); return { ok: true, out: "" }; },
      });
      const result = await manager.applyRelease([]);
      expect(result.ok).toBe(false);
      expect(JSON.parse(settings.get("release_inflight") || "{}").phase).toBe("recovery-required");
      expect(receipts.at(-1)?.result).toBe("recovery-failed");
    } finally { rmSync(repo.root, { recursive: true, force: true }); }
  }
}, 60000);

test("오래된 콜백은 새 소유자의 저널을 지우거나 갱신하지 못한다", async () => {
  const repo = releaseRepo();
  try {
    const { manager, settings, receipts } = isolatedManager(repo.root, { makeOwner: () => "owner-a" });
    const newer = {
      schema: 2, owner: "owner-b", operation: "winback", from: repo.target, to: repo.before,
      phase: "staging", startedAt: 2,
    };
    const result = await manager.applyRelease([{
      name: "소유권 교체 주입",
      run: async () => {
        settings.set("release_inflight", JSON.stringify(newer));
        return { ok: false, out: "이전 작업 실패" };
      },
    }]);

    expect(result.ok).toBe(false);
    expect(JSON.parse(settings.get("release_inflight") || "{}")).toEqual(newer);
    expect(receipts.at(-1)?.result).toBe("rejected");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("마지막 live 검증 중 소유권을 잃은 apply는 설정·태그·이력을 쓰지 않는다", async () => {
  const repo = releaseRepo();
  try {
    let settingsRef!: Map<string, string>;
    const newer = {
      schema: 2, owner: "owner-b", operation: "winback", from: repo.target, to: repo.before,
      phase: "verifying", startedAt: 2,
    };
    const ctx = isolatedManager(repo.root, {
      makeOwner: () => "owner-a",
      deployGates: () => [{
        name: "소유권 교체 live 게이트",
        run: async () => {
          settingsRef.set("release_inflight", JSON.stringify(newer));
          return { ok: true, out: "" };
        },
      }],
    });
    settingsRef = ctx.settings;
    const result = await ctx.manager.applyRelease([]);

    expect(result.ok).toBe(false);
    expect(JSON.parse(ctx.settings.get("release_inflight") || "{}")).toEqual(newer);
    expect(ctx.settings.get("release_prev_sha")).toBeUndefined();
    expect(ctx.settings.get("release_applied_at")).toBeUndefined();
    expect(ctx.settings.get("app_version")).toBeUndefined();
    expect(ctx.settings.get("release_history")).toBeUndefined();
    expect(gitAt(repo.root, "rev-parse", "--verify", "refs/tags/v0.0.1").ok).toBe(false);
    expect(ctx.receipts.at(-1)?.result).toBe("recovery-failed");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("apply가 게이트에서 대기 중이면 winback과 revert는 Git mutation 없이 거부된다", async () => {
  const repo = releaseRepo();
  try {
    let releaseGate!: (result: { ok: boolean; out: string }) => void;
    let resets = 0;
    const { manager, settings } = isolatedManager(repo.root, {
      git: (...args) => {
        if (args[0] === "reset") resets++;
        return gitAt(repo.root, ...args);
      },
    });
    const applying = manager.applyRelease([{
      name: "대기 게이트",
      run: () => new Promise((resolve) => { releaseGate = resolve; }),
    }]);
    expect(settings.get("release_inflight")).toContain('"operation":"apply"');

    const winback = await manager.winbackRelease();
    const revert = await manager.revertRelease();
    expect(winback.ok).toBe(false);
    expect(revert.ok).toBe(false);
    if (!winback.ok) expect(winback.error).toContain("다른 릴리스 작업");
    if (!revert.ok) expect(revert.error).toContain("다른 릴리스 작업");
    expect(resets).toBe(0);

    releaseGate({ ok: false, out: "대기 종료" });
    await applying;
    expect(settings.get("release_inflight")).toBe("");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("winback이나 revert가 boot에서 대기 중이어도 다른 릴리스 mutation은 모두 거부된다", async () => {
  const winbackRepo = releaseRepo();
  const revertRepo = releaseRepo();
  try {
    mustGit(winbackRepo.root, "merge", "--ff-only", winbackRepo.target);
    let releaseWinbackBoot!: (result: { ok: boolean; out: string }) => void;
    let winbackResets = 0;
    const winbackCtx = isolatedManager(winbackRepo.root, {
      git: (...args) => {
        if (args[0] === "reset") winbackResets++;
        return gitAt(winbackRepo.root, ...args);
      },
      bootCheck: () => new Promise((resolve) => { releaseWinbackBoot = resolve; }),
    });
    winbackCtx.settings.set("release_history", JSON.stringify(appliedHistory(winbackRepo)));
    const runningWinback = winbackCtx.manager.winbackRelease();
    expect(winbackCtx.settings.get("release_inflight")).toContain('"operation":"winback"');
    const blockedApply = await winbackCtx.manager.applyRelease([]);
    const blockedRevert = await winbackCtx.manager.revertRelease();
    expect(blockedApply.ok).toBe(false);
    expect(blockedRevert.ok).toBe(false);
    expect(winbackResets).toBe(1);
    releaseWinbackBoot({ ok: true, out: "" });
    expect((await runningWinback).ok).toBe(true);

    mustGit(revertRepo.root, "merge", "--ff-only", revertRepo.target);
    let releaseRevertBoot!: (result: { ok: boolean; out: string }) => void;
    let revertResets = 0;
    const revertCtx = isolatedManager(revertRepo.root, {
      git: (...args) => {
        if (args[0] === "reset") revertResets++;
        return gitAt(revertRepo.root, ...args);
      },
      bootCheck: () => new Promise((resolve) => { releaseRevertBoot = resolve; }),
    });
    revertCtx.settings.set("release_prev_sha", revertRepo.before);
    const runningRevert = revertCtx.manager.revertRelease();
    expect(revertCtx.settings.get("release_inflight")).toContain('"operation":"revert"');
    const revertBlockedApply = await revertCtx.manager.applyRelease([]);
    const revertBlockedWinback = await revertCtx.manager.winbackRelease();
    expect(revertBlockedApply.ok).toBe(false);
    expect(revertBlockedWinback.ok).toBe(false);
    expect(revertResets).toBe(1);
    releaseRevertBoot({ ok: true, out: "" });
    expect((await runningRevert).ok).toBe(true);
  } finally {
    rmSync(winbackRepo.root, { recursive: true, force: true });
    rmSync(revertRepo.root, { recursive: true, force: true });
  }
}, 30000);

function appliedHistory(repo: ReturnType<typeof releaseRepo>): ReleaseRecord[] {
  return [{
    version: "0.0.1", tier: "patch", sha: repo.target, prevSha: repo.before,
    appliedAt: 1, subjects: ["긴급: 대상 B"], status: "applied",
  }];
}

test("윈백 대상 검증 실패 뒤 원래 HEAD 보상이 성공하면 이력을 바꾸지 않는다", async () => {
  const repo = releaseRepo();
  try {
    mustGit(repo.root, "merge", "--ff-only", repo.target);
    let boots = 0;
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      bootCheck: async () => ++boots === 1 ? { ok: false, out: "대상 boot 실패" } : { ok: true, out: "" },
    });
    const history = appliedHistory(repo);
    settings.set("release_history", JSON.stringify(history));
    const result = await manager.winbackRelease();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("원래 상태");
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.target);
    expect(JSON.parse(settings.get("release_history") || "[]")).toEqual(history);
    expect(settings.get("release_inflight")).toBe("");
    expect(receipts.at(-1)?.result).toBe("rolled-back");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("윈백 boot 중 clean 외부 HEAD가 생기면 성공이나 보상으로 오인하지 않고 보존한다", async () => {
  const repo = releaseRepo();
  try {
    mustGit(repo.root, "merge", "--ff-only", repo.target);
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      bootCheck: async () => {
        mustGit(repo.root, "reset", "--hard", repo.next);
        return { ok: true, out: "" };
      },
    });
    const history = appliedHistory(repo);
    settings.set("release_history", JSON.stringify(history));
    const result = await manager.winbackRelease();

    expect(result.ok).toBe(false);
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.next);
    expect(mustGit(repo.root, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(JSON.parse(settings.get("release_history") || "[]")).toEqual(history);
    expect(JSON.parse(settings.get("release_inflight") || "{}").phase).toBe("recovery-required");
    expect(receipts.at(-1)?.result).toBe("recovery-failed");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("윈백 boot 중 외부 dirty 변경이 있으면 최종 검증이 잡고 보상 reset으로 지우지 않는다", async () => {
  const repo = releaseRepo();
  try {
    mustGit(repo.root, "merge", "--ff-only", repo.target);
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      bootCheck: async () => {
        writeFileSync(join(repo.root, "state.txt"), "윈백 중 외부 dirty 변경\n");
        return { ok: true, out: "" };
      },
    });
    const history = appliedHistory(repo);
    settings.set("release_history", JSON.stringify(history));
    const result = await manager.winbackRelease();

    expect(result.ok).toBe(false);
    expect(mustGit(repo.root, "rev-parse", "HEAD")).toBe(repo.before);
    expect(readFileSync(join(repo.root, "state.txt"), "utf8")).toBe("윈백 중 외부 dirty 변경\n");
    expect(JSON.parse(settings.get("release_history") || "[]")).toEqual(history);
    expect(JSON.parse(settings.get("release_inflight") || "{}").phase).toBe("recovery-required");
    expect(receipts.at(-1)?.result).toBe("recovery-failed");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("윈백 실패 뒤 원래 HEAD 보상도 실패하면 이력은 그대로이고 recovery-required다", async () => {
  const repo = releaseRepo();
  try {
    mustGit(repo.root, "merge", "--ff-only", repo.target);
    let resets = 0;
    const { manager, settings, receipts } = isolatedManager(repo.root, {
      git: (...args) => {
        if (args[0] === "reset" && ++resets === 2) return { ok: false, out: "보상 reset 실패" };
        return gitAt(repo.root, ...args);
      },
      bootCheck: async () => ({ ok: false, out: "대상 boot 실패" }),
    });
    const history = appliedHistory(repo);
    settings.set("release_history", JSON.stringify(history));
    const result = await manager.winbackRelease();

    expect(result.ok).toBe(false);
    expect(JSON.parse(settings.get("release_history") || "[]")).toEqual(history);
    expect(JSON.parse(settings.get("release_inflight") || "{}").phase).toBe("recovery-required");
    expect(receipts.at(-1)?.result).toBe("recovery-failed");
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
}, 30000);

test("윈백과 레거시 revert는 성공 검증 뒤에만 원장과 설정을 갱신한다", async () => {
  const winbackRepo = releaseRepo();
  const revertRepo = releaseRepo();
  try {
    mustGit(winbackRepo.root, "merge", "--ff-only", winbackRepo.target);
    const winbackCtx = isolatedManager(winbackRepo.root);
    winbackCtx.settings.set("release_history", JSON.stringify(appliedHistory(winbackRepo)));
    const winback = await winbackCtx.manager.winbackRelease();
    expect(winback.ok).toBe(true);
    expect(mustGit(winbackRepo.root, "rev-parse", "HEAD")).toBe(winbackRepo.before);
    const winbackHistory = JSON.parse(winbackCtx.settings.get("release_history") || "[]") as ReleaseRecord[];
    expect(winbackHistory).toHaveLength(2);
    expect(winbackHistory[0].status).toBe("reverted");
    expect(winbackHistory[1]).toEqual(expect.objectContaining({ sha: winbackRepo.before, prevSha: winbackRepo.target, status: "applied" }));
    expect(winbackCtx.settings.get("release_prev_sha")).toBe(winbackRepo.target);
    expect(winbackCtx.settings.get("release_inflight")).toBe("");
    expect(winbackCtx.receipts.at(-1)?.result).toBe("winback");

    mustGit(revertRepo.root, "merge", "--ff-only", revertRepo.target);
    const revertCtx = isolatedManager(revertRepo.root);
    revertCtx.settings.set("release_prev_sha", revertRepo.before);
    const reverted = await revertCtx.manager.revertRelease();
    expect(reverted.ok).toBe(true);
    expect(mustGit(revertRepo.root, "rev-parse", "HEAD")).toBe(revertRepo.before);
    expect(revertCtx.settings.get("release_prev_sha")).toBe("");
    expect(revertCtx.settings.get("release_inflight")).toBe("");
    expect(revertCtx.receipts.at(-1)?.result).toBe("revert");
  } finally {
    rmSync(winbackRepo.root, { recursive: true, force: true });
    rmSync(revertRepo.root, { recursive: true, force: true });
  }
}, 30000);

test("재기동 복구는 recovery-required를 지우지 않고 레거시 저널도 보존 형식으로 승격한다", () => {
  const repo = releaseRepo();
  try {
    const current = isolatedManager(repo.root, { makeOwner: () => "recovery-owner" });
    const journal = {
      schema: 2, owner: "owner-a", operation: "apply", from: repo.before, to: repo.target,
      phase: "recovery-required", startedAt: 1, error: "이미 복구 필요",
    };
    current.settings.set("release_inflight", JSON.stringify(journal));
    expect(current.manager.recoverJournal()?.result).toBe("interrupted");
    expect(JSON.parse(current.settings.get("release_inflight") || "{}")).toEqual(journal);

    const legacy = isolatedManager(repo.root, { makeOwner: () => "legacy-owner" });
    legacy.settings.set("release_inflight", JSON.stringify({ from: repo.before, to: repo.target, subjects: [], ts: 7 }));
    expect(legacy.manager.recoverJournal()?.result).toBe("interrupted");
    const converted = JSON.parse(legacy.settings.get("release_inflight") || "{}") as { schema?: number; owner?: string; phase?: string };
    expect(converted).toEqual(expect.objectContaining({ schema: 2, owner: "recovery-legacy-owner", phase: "recovery-required" }));
    expect(legacy.receipts.at(-1)?.result).toBe("interrupted");

    const active = isolatedManager(repo.root);
    active.settings.set("release_inflight", JSON.stringify({ ...journal, owner: "active-owner", phase: "verifying" }));
    expect(active.manager.recoverJournal()?.result).toBe("interrupted");
    expect(JSON.parse(active.settings.get("release_inflight") || "{}")).toEqual(expect.objectContaining({
      owner: "active-owner", phase: "recovery-required",
    }));
  } finally { rmSync(repo.root, { recursive: true, force: true }); }
});

// --- 영수증·저널 (개선지침서 R1·R3) ---

test("영수증은 쌓이고 최신이 먼저 나온다", () => {
  const dir = mkdtempSync(join(tmpdir(), "mybot-receipt-"));
  const path = join(dir, "log.jsonl");
  try {
    writeReceipt({ ts: 1, from: "a", to: "b", subjects: ["첫 적용"], gates: ["테스트"], result: "applied" }, path);
    writeReceipt({ ts: 2, from: "b", to: "c", subjects: ["둘째"], gates: [], result: "rolled-back", error: "테스트 실패" }, path);
    const rs = readReceipts(10, path);
    expect(rs.map((r) => r.ts)).toEqual([2, 1]);
    expect(rs[0].result).toBe("rolled-back");
    expect(rs[0].error).toContain("테스트 실패");
    expect(rs[1].gates).toEqual(["테스트"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("영수증 파일이 없으면 빈 목록이다 — 조회가 실패하지 않는다", () => {
  expect(readReceipts(10, join(tmpdir(), "mybot-no-such-file.jsonl"))).toEqual([]);
});

test("끝나지 못한 적용은 중단 영수증으로 남는다", () => {
  const r = interruptedReceipt(JSON.stringify({ from: "aaa1111", to: "bbb2222", subjects: ["기동 시험 추가"], ts: 1 }), 99);
  expect(r.result).toBe("interrupted");
  expect(r.from).toBe("aaa1111");
  expect(r.subjects).toEqual(["기동 시험 추가"]);
  expect(r.ts).toBe(99);
  expect(r.error).toContain("프로세스가 종료");
});

test("저널이 깨져 있어도 중단 사실은 남긴다", () => {
  // 기록이 망가졌다고 조용히 넘어가면, 반영만 된 채 재시작이 안 된 상태를 놓친다
  const r = interruptedReceipt("{깨진 JSON", 99);
  expect(r.result).toBe("interrupted");
  expect(r.from).toBe("");
  expect(r.error).toContain("프로세스가 종료");
});

test("여러 조건이 동시에 어긋나면 가장 먼저 막아야 할 사유를 알린다", () => {
  // 브랜치 자체가 없으면 나머지를 따질 필요가 없다
  expect(evaluateRelease({ hasChannel: false, pending: 0, clean: false, ff: false }).reason).toContain("아직 없습니다");
  // 브랜치는 있으나 더티하고 갈라진 경우 — 먼저 해결해야 하는 쪽은 작업 폴더다
  expect(evaluateRelease({ hasChannel: true, pending: 1, clean: false, ff: false }).reason).toContain("커밋되지 않은 변경");
});

// --- 버전 등급 분류·배치 임계·윈백 (3등급 릴리스 정책) ---

test("커밋 제목에 긴급이 붙으면 긴급패치다 — 한 건이어도 즉시 나간다", () => {
  expect(classifyTier(["긴급: 인증 오류 수정"], ["server/src/routes/chat.ts"])).toBe("patch");
  expect(classifyTier(["hotfix: 결제 폴백 무한루프"], ["server/src/team.ts"])).toBe("patch");
  const r = evaluateRelease({ ...ok, pending: 1, tier: "patch", oldestAgeMs: 0 });
  expect(r.canApply).toBe(true); // 임계를 기다리지 않는다
});

test("파괴적 표면이나 명시 표시만 메이저다 — evolve·파일 수는 메이저가 아니다", () => {
  // 인증·승인·릴리스·암호·DB·기동·의존성은 한 줄만 건드려도 메이저
  expect(classifyTier(["승인 흐름 보강"], ["server/src/approvals.ts"])).toBe("major");
  expect(classifyTier(["의존성 갱신"], ["package.json"])).toBe("major");
  expect(classifyTier(["스키마 변경"], ["server/src/db.ts"])).toBe("major");
  // 제목으로 명시한 메이저도 인정한다 — 파괴적이지만 표면 목록에 없는 변경용
  expect(classifyTier(["메이저: API 계약 변경"], ["server/src/routes/chat.ts"])).toBe("major");
  // 개발 단계의 일상 작업은 메이저가 아니다 — evolve 내부 도구·대규모 변경·라우트 추가
  expect(classifyTier(["자기개선 격리"], ["evolve/surfaces.json"])).toBe("minor");
  expect(classifyTier(["토너먼트 개선"], ["server/src/evolve.ts"])).toBe("minor");
  expect(classifyTier(["UI 다수 개선"], Array.from({ length: 15 }, (_, i) => `web/src/c${i}.tsx`))).toBe("minor");
  // 개발 단계(dev)의 메이저는 정착 없이 바로 적용된다 — 출시 단계(launch)만 12시간 정착
  expect(evaluateRelease({ ...ok, pending: 1, tier: "major", newestAgeMs: 3600_000, stage: "dev" }).canApply).toBe(true);
  const fresh = evaluateRelease({ ...ok, pending: 1, tier: "major", newestAgeMs: 3600_000, stage: "launch" });
  expect(fresh.canApply).toBe(false);
  expect(fresh.reason).toContain("정착");
  expect(evaluateRelease({ ...ok, pending: 1, tier: "major", newestAgeMs: 13 * 3600_000, stage: "launch" }).canApply).toBe(true);
});

test("일상 개선 묶음은 마이너 — 3건 미만이고 72시간도 안 지났으면 보류한다", () => {
  expect(classifyTier(["표현 다듬기"], ["web/src/components/Composer.tsx"])).toBe("minor");
  const hold = evaluateRelease({ ...ok, pending: 2, tier: "minor", oldestAgeMs: 3600_000 });
  expect(hold.canApply).toBe(false);
  expect(hold.reason).toContain("쌓이면");
  // 3건 이상이면 나간다
  expect(evaluateRelease({ ...ok, pending: 3, tier: "minor", oldestAgeMs: 3600_000 }).canApply).toBe(true);
  // 건수가 적어도 첫 커밋이 72시간을 넘기면 나간다 — 개선을 영원히 붙들지 않는다
  expect(evaluateRelease({ ...ok, pending: 1, tier: "minor", oldestAgeMs: 73 * 3600_000 }).canApply).toBe(true);
});

test("버전 번호는 단계·등급대로 오른다", () => {
  // 출시 단계 — 정규 semver
  expect(nextVersion("1.2.3", "patch", "launch")).toBe("1.2.4");
  expect(nextVersion("1.2.3", "minor", "launch")).toBe("1.3.0");
  expect(nextVersion("1.2.3", "major", "launch")).toBe("2.0.0");
  // 개발 단계 — 0.x 유지: 메이저만 중간 번호, 나머지는 끝 번호
  expect(nextVersion("0.2.0", "major", "dev")).toBe("0.3.0");
  expect(nextVersion("0.2.0", "minor", "dev")).toBe("0.2.1");
  expect(nextVersion("0.2.0", "patch", "dev")).toBe("0.2.1");
  expect(nextVersion(null, "minor", "dev")).toBe("0.0.1");
  expect(nextVersion(null, "major", "dev")).toBe("0.1.0");
  // 개발 단계에서는 1.0.0 이전 기록이 있어도 0.x로 유지한다 (구 버전 원장과 무관)
  expect(nextVersion("3.0.0", "major", "dev")).toBe("0.1.0");
  // 출시 전환 후 첫 메이저가 1.0.0이다
  expect(nextVersion("0.9.2", "major", "launch")).toBe("1.0.0");
});

test("윈백 대상은 버전 원장에 기록된 지점만 된다", () => {
  const h: ReleaseRecord[] = [
    { version: "1.0.0", tier: "major", sha: "aaa", prevSha: "000", appliedAt: 1, subjects: ["처음"], status: "applied" },
    { version: "1.1.0", tier: "minor", sha: "bbb", prevSha: "aaa", appliedAt: 2, subjects: ["개선"], status: "applied" },
  ];
  // 지정 없으면 직전 버전의 prevSha = 마지막 적용을 되돌리는 지점
  expect(pickWinbackTarget(h, "bbb")).toEqual({ sha: "aaa", label: "1.0.0" });
  // 기록된 어느 버전으로도 갈 수 있다
  expect(pickWinbackTarget(h, "bbb", "000")).toEqual({ sha: "000", label: "000" });
  // 기록에 없는 지점·현재 위치·빈 원장은 거부
  expect(pickWinbackTarget(h, "bbb", "zzz")).toEqual(expect.objectContaining({ ok: false }));
  expect(pickWinbackTarget(h, "bbb", "bbb")).toEqual(expect.objectContaining({ ok: false }));
  expect(pickWinbackTarget([], "bbb")).toEqual(expect.objectContaining({ ok: false }));
});
