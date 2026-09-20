import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";

import { courseDraftJsonSchema } from "./assets";

export class BedrockConfigurationError extends Error {}
export class BedrockInvocationError extends Error {}

export interface BedrockConfig {
  region: string;
  modelId: string;
  timeoutMs: number;
}

export function bedrockConfigFromEnv(): BedrockConfig {
  const region = process.env.AWS_REGION;
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!region || !modelId) {
    throw new BedrockConfigurationError(
      "AWS_REGION과 BEDROCK_MODEL_ID 환경변수가 필요합니다.",
    );
  }

  const timeoutMs = Number(process.env.BEDROCK_TIMEOUT_MS ?? 180_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new BedrockConfigurationError("BEDROCK_TIMEOUT_MS는 1000 이상의 숫자여야 합니다.");
  }

  return { region, modelId, timeoutMs };
}

const clients = new Map<string, BedrockRuntimeClient>();

function clientFor(region: string): BedrockRuntimeClient {
  let client = clients.get(region);
  if (!client) {
    client = new BedrockRuntimeClient({ region });
    clients.set(region, client);
  }
  return client;
}

export async function callBedrockCourseDraft(options: {
  system: string;
  user: string;
  config?: BedrockConfig;
}): Promise<string> {
  const config = options.config ?? bedrockConfigFromEnv();
  const input: ConverseCommandInput = {
    modelId: config.modelId,
    system: [{ text: options.system }],
    messages: [{ role: "user", content: [{ text: options.user }] }],
    inferenceConfig: {
      maxTokens: 4_096,
      temperature: 0.2,
      topP: 0.9,
    },
    outputConfig: {
      textFormat: {
        type: "json_schema",
        structure: {
          jsonSchema: {
            name: "date_course_draft",
            description: "장소 선택, 순서, 추천 근거만 포함한 데이트 코스 초안",
            schema: JSON.stringify(courseDraftJsonSchema()),
          },
        },
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await clientFor(config.region).send(new ConverseCommand(input), {
      abortSignal: controller.signal,
    });
    const text = response.output?.message?.content
      ?.map((block) => block.text ?? "")
      .join("")
      .trim();

    if (!text) {
      throw new BedrockInvocationError(
        `Bedrock 응답에 텍스트가 없습니다. stopReason=${response.stopReason ?? "unknown"}`,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof BedrockInvocationError) throw error;
    if (controller.signal.aborted) {
      throw new BedrockInvocationError(
        `Bedrock 요청이 ${config.timeoutMs}ms 제한 시간을 초과했습니다.`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new BedrockInvocationError(`Bedrock Claude 호출 실패: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
