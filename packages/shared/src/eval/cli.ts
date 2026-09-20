import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ALL_MBTI, type Mbti } from '../types';
import {
  FIXTURE_FILES,
  formatReport,
  runEvaluation,
  type CallModel,
  type FixtureId,
} from './run-cases';

/**
 * 프롬프트 회귀 스위트 실행기. 레포 루트에서 실행한다.
 *
 *   npx tsx packages/shared/src/eval/cli.ts --caller ./scripts/call-model.ts
 *
 * --caller에 지정한 모듈은 CallModel 시그니처의 함수를 default로 내보내야 한다.
 * LLM 공급자를 레포에 고정하지 않기 위해 호출부를 밖으로 뺐다.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      caller: { type: "string" },
      fixture: { type: "string", multiple: true },
      types: { type: "string" },
      "no-pre-rank": { type: "boolean", default: false },
    },
  });

  if (!values.caller) {
    console.error(
      '사용법: npx tsx packages/shared/src/eval/cli.ts --caller <모듈 경로> [--fixture <id>] [--types INFP,ESTJ]',
    );
    console.error(`사용 가능한 픽스처: ${FIXTURE_FILES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const callerModule = (await import(pathToFileURL(resolve(values.caller)).href)) as {
    default?: CallModel;
  };
  const callModel = callerModule.default;

  if (typeof callModel !== "function") {
    console.error(`${values.caller}가 CallModel 함수를 default로 내보내지 않았습니다.`);
    process.exitCode = 1;
    return;
  }

  const fixtures = (values.fixture ?? [...FIXTURE_FILES]) as FixtureId[];
  const unknown = fixtures.filter((id) => !FIXTURE_FILES.includes(id));
  if (unknown.length > 0) {
    console.error(`알 수 없는 픽스처: ${unknown.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const types = values.types
    ? (values.types.split(",").map((value) => value.trim().toUpperCase()) as Mbti[])
    : ALL_MBTI;

  const reports = await runEvaluation({
    callModel,
    fixtures,
    types,
    preRank: !values["no-pre-rank"],
    onProgress: (fixtureId, mbti, index, total) => {
      process.stderr.write(`\r${fixtureId} ${index}/${total} (${mbti})   `);
    },
  });

  process.stderr.write("\n");
  console.log(formatReport(reports));

  const failed = reports.some(
    (report) =>
      report.factualityErrors > 0 ||
      report.evidenceCoverage < 1 ||
      !report.differentiation.withinTarget,
  );
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
