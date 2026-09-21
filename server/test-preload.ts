// 테스트 전용 진입점. 서비스 실행에 사용하지 않는다.
if (process.env.NODE_ENV !== "test") throw new Error("NODE_ENV=test required");
globalThis.fetch = (async () => { throw new Error("Unmocked network request blocked"); }) as unknown as typeof fetch;
const { db, setSetting } = await import("./src/db");
if (db.filename !== ":memory:") throw new Error("메모리 DB에서만 테스트");
// 기존 회귀 테스트의 API mock용 식별자. 실제 GLM 호출이나 운영 모델 변경이 아니다.
setSetting("default_model", "zai/glm-5.3-flash");
