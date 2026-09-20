import { describe, expect, spyOn, test } from 'bun:test';
import { evaluateResult, parseEvaluationResponse } from './evaluate';

const sensitiveMarker = 'SYNTHETIC_PRIVATE_PROVIDER_DETAIL_DO_NOT_EXPOSE';

function expectInconclusive(
  verdict: ReturnType<typeof parseEvaluationResponse>,
  reasonCode: 'provider_error' | 'invalid_response' | 'aborted',
) {
  expect(verdict).toMatchObject({
    pass: false,
    score: 0,
    status: 'inconclusive',
    reasonCode,
  });
  expect(Array.isArray(verdict.issues)).toBe(true);
  expect(verdict.issues.every((issue) => typeof issue === 'string')).toBe(true);
  expect(verdict.issues.length).toBeLessThanOrEqual(3);
}

describe('parseEvaluationResponse 공개 계약', () => {
  for (const score of [0, 69, 70, 100]) {
    test(`${score}점은 scored이며 pass 경계는 70점이다`, () => {
      const verdict = parseEvaluationResponse(JSON.stringify({ score, issues: [] }));
      expect(verdict).toMatchObject({ pass: score >= 70, score, issues: [], status: 'scored' });
      expect(verdict.reasonCode).toBeUndefined();
    });
  }

  test('단일 JSON 객체 주변의 공백을 허용한다', () => {
    expect(parseEvaluationResponse(' \n\t {"score":80,"issues":["확인"]} \r\n')).toMatchObject({
      pass: true, score: 80, issues: ['확인'], status: 'scored',
    });
  });

  test('단일 json 코드펜스를 허용한다', () => {
    expect(parseEvaluationResponse(' \n```json\n{"score":80,"issues":[]}\n```\n ')).toMatchObject({
      pass: true, score: 80, issues: [], status: 'scored',
    });
  });

  const invalidResponses: Array<[string, string]> = [
    ['빈 응답', ''],
    ['공백뿐인 응답', ' \n\t '],
    ['깨진 JSON', '{"score":80,"issues":[]'],
    ['JSON 앞 산문', '평가 결과: {"score":80,"issues":[]}'],
    ['JSON 뒤 산문', '{"score":80,"issues":[]} 완료'],
    ['코드펜스 앞 산문', '결과입니다\n```json\n{"score":80,"issues":[]}\n```'],
    ['두 JSON 객체', '{"score":80,"issues":[]}\n{"score":90,"issues":[]}'],
    ['두 코드펜스', '```json\n{"score":80,"issues":[]}\n```\n```json\n{"score":90,"issues":[]}\n```'],
    ['배열', '[{"score":80,"issues":[]}]'],
    ['null', 'null'],
    ['점수 누락', '{"issues":[]}'],
    ['문자열 점수', '{"score":"80","issues":[]}'],
    ['boolean 점수', '{"score":true,"issues":[]}'],
    ['null 점수', '{"score":null,"issues":[]}'],
    ['음수 점수', '{"score":-1,"issues":[]}'],
    ['100 초과 점수', '{"score":101,"issues":[]}'],
    ['유한하지 않은 점수', '{"score":1e999,"issues":[]}'],
    ['issues 누락', '{"score":80}'],
    ['문자열 issues', '{"score":80,"issues":"문제"}'],
    ['숫자 issues 원소', '{"score":80,"issues":["문제",3]}'],
    ['null issues 원소', '{"score":80,"issues":[null]}'],
    ['객체 issues 원소', '{"score":80,"issues":[{}]}'],
    ['boolean issues 원소', '{"score":80,"issues":[false]}'],
  ];

  for (const [name, content] of invalidResponses) {
    test(`${name}은 invalid_response이다`, () => {
      expectInconclusive(parseEvaluationResponse(content), 'invalid_response');
    });
  }

  test('issues는 최대 세 개까지만 반환한다', () => {
    const verdict = parseEvaluationResponse(JSON.stringify({ score: 80, issues: ['하나', '둘', '셋', '넷'] }));
    expect(verdict).toMatchObject({ pass: true, score: 80, status: 'scored' });
    expect(verdict.issues).toHaveLength(3);
    expect(verdict.issues.every((issue) => ['하나', '둘', '셋', '넷'].includes(issue))).toBe(true);
  });

  test('깨진 모델 응답 원문을 issues에 노출하지 않는다', () => {
    const verdict = parseEvaluationResponse(`broken-response:${sensitiveMarker}`);
    expectInconclusive(verdict, 'invalid_response');
    expect(verdict.issues.join('\n')).not.toContain(sensitiveMarker);
  });
});

type EvaluationOptions = NonNullable<Parameters<typeof evaluateResult>[4]>;
type ModelCall = NonNullable<EvaluationOptions['callModel']>;

const endpoint = {
  id: 'fixture',
  name: 'fixture',
  kind: 'openai',
  baseUrl: 'http://fixture.invalid',
} as Parameters<typeof evaluateResult>[0];

function evaluateWith(callModel: ModelCall, signal?: AbortSignal) {
  return evaluateResult(endpoint, 'fixture-model', 'fixture-task', 'fixture-result', { callModel, signal });
}

describe('evaluateResult 주입 및 실패 공개 계약', () => {
  test('60초 deadline은 영원히 pending인 제공자를 aborted로 종료한다', async () => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation(() => originalTimeout(1));
    let callCount = 0;

    try {
      const verdict = await evaluateWith(async () => {
        callCount += 1;
        return new Promise<never>(() => {});
      });

      expect(timeoutSpy).toHaveBeenCalledWith(60_000);
      expect(callCount).toBe(1);
      expectInconclusive(verdict, 'aborted');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  test('주입한 callModel로 정상 평가하고 signal과 low 추론 설정을 전달한다', async () => {
    const controller = new AbortController();
    const calls: Parameters<ModelCall>[] = [];
    const callModel: ModelCall = async (...args) => {
      calls.push(args);
      return { content: '{"score":80,"issues":[]}' };
    };

    const verdict = await evaluateWith(callModel, controller.signal);

    expect(verdict).toMatchObject({ pass: true, score: 80, issues: [], status: 'scored' });
    expect(calls).toHaveLength(1);
    const [receivedEndpoint, receivedModel, messages, options] = calls[0]!;
    expect(receivedEndpoint).toEqual(endpoint);
    expect(receivedModel).toBe('fixture-model');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBeGreaterThan(0);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal.aborted).toBe(false);
    expect(options.reasoningEffort).toBe('low');
  });

  test('정상 호출의 낮은 점수는 inconclusive가 아닌 scored이다', async () => {
    const verdict = await evaluateWith(async () => ({ content: '{"score":69,"issues":["보완 필요"]}' }));
    expect(verdict).toMatchObject({ pass: false, score: 69, issues: ['보완 필요'], status: 'scored' });
    expect(verdict.reasonCode).toBeUndefined();
  });

  test('제공자 reject는 provider_error이다', async () => {
    const verdict = await evaluateWith(async () => { throw new Error('fixture provider failed'); });
    expectInconclusive(verdict, 'provider_error');
  });

  test('제공자의 빈 content는 invalid_response이다', async () => {
    const verdict = await evaluateWith(async () => ({ content: '' }));
    expectInconclusive(verdict, 'invalid_response');
  });

  test('모델의 깨진 응답은 invalid_response이며 민감 원문을 노출하지 않는다', async () => {
    const verdict = await evaluateWith(async () => ({ content: `broken-response:${sensitiveMarker}` }));
    expectInconclusive(verdict, 'invalid_response');
    expect(verdict.issues.join('\n')).not.toContain(sensitiveMarker);
  });

  test('사전 취소된 signal이면 제공자를 한 번도 호출하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    let callCount = 0;
    const verdict = await evaluateWith(async () => {
      callCount += 1;
      return { content: '{"score":100,"issues":[]}' };
    }, controller.signal);
    expect(callCount).toBe(0);
    expectInconclusive(verdict, 'aborted');
  });

  test('실행 중 취소 후 제공자가 유효 응답을 반환해도 성공 처리하지 않는다', async () => {
    const controller = new AbortController();
    let callCount = 0;
    let abortedBefore: boolean | undefined;
    let abortedAfter: boolean | undefined;
    const verdict = await evaluateWith(async (_endpoint, _model, _messages, options) => {
      callCount += 1;
      abortedBefore = options.signal.aborted;
      controller.abort();
      await Promise.resolve();
      abortedAfter = options.signal.aborted;
      return { content: '{"score":100,"issues":[]}' };
    }, controller.signal);
    expect(callCount).toBe(1);
    expect(abortedBefore).toBe(false);
    expect(abortedAfter).toBe(true);
    expectInconclusive(verdict, 'aborted');
  });

  test('제공자의 민감 오류 메시지를 issues에 노출하지 않는다', async () => {
    const verdict = await evaluateWith(async () => { throw new Error(sensitiveMarker); });
    expectInconclusive(verdict, 'provider_error');
    expect(verdict.issues.join('\n')).not.toContain(sensitiveMarker);
  });
});
