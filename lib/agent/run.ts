/**
 * The agent loop. SERVER ONLY.
 *
 * An async generator rather than a function returning a promise: the route turns
 * whatever this yields straight into NDJSON lines, so a status event reaches the
 * sheet the moment a tool starts instead of when the whole turn resolves. That
 * is the only reason the sheet can say "성수 근처를 보는 중" during an Apify run
 * that takes twenty seconds.
 *
 * `GEMINI_API_KEY` is read here, inside the function, for the reason
 * `lib/extract/caption.ts` states: importing this file — which `next build` does
 * for the route that references it — must not require the key to be present at
 * build time.
 */

import { GoogleGenAI, type Content, type FunctionCall } from '@google/genai';

import { TOOL_DECLARATIONS, forUser } from './tools';
import { systemInstruction } from './prompt';
import type { SessionUser } from '../session';
import type { AgentEvent, AgentMessage } from './types';

/**
 * Pinned, not `-latest`, for the reason `lib/extract/caption.ts` gives: an alias
 * that moves underneath a behaviour people have built on turns a model upgrade
 * into an unexplained change with no diff to point at.
 *
 * Flash rather than the caption extractor's flash-lite. That one copies fields
 * out of a 1.2 KB caption; this one has to decide which of four tools to call,
 * read ten thousand characters of blog prose, and order five stops against
 * opening hours. Lite is the wrong rung for the judgement half.
 *
 * `gemini-3.1-flash` was the original pin and IT DOES NOT EXIST — every turn
 * 404'd and the sheet showed "대답하는 중에 문제가 생겼어요" with nothing in the
 * server log to explain it, because the failure arrived as an in-band error
 * event after the stream had opened. `3.1` ships lite, image and tts variants
 * but no plain flash. Verify a pin against `ListModels` before trusting it; a
 * name that reads plausibly is not a name that resolves.
 */
const MODEL = 'gemini-3.5-flash';

/**
 * A turn gets six model calls. Five tools' worth of work plus the answer is the
 * realistic ceiling — saved places, nearby, two researches, a course — and
 * anything past that is a loop, not a plan. The cap is a hard stop rather than a
 * warning because the user is watching a spinner while it spends.
 *
 * `discover_places` fits without raising it: the path it exists for is saved
 * places (1), nearby (2), discovery (3), answer (4). That is the point of
 * telling the model to try the free tools first — the expensive call arrives
 * when there are still steps to spend on saying what it found. The cap on
 * discovery itself is not here but in `lib/agent/tools.ts`, which allows one per
 * turn and refuses to start one late; a step budget cannot express "this
 * particular step costs thirty seconds and real money".
 */
const MAX_STEPS = 6;

/** How much history travels. Ten turns is roughly what the sheet shows without scrolling far, and the tools re-read state each turn anyway. */
const MAX_HISTORY = 20;

/**
 * Runs one turn.
 *
 * Never throws: every failure is yielded as an `error` event followed by `done`,
 * because the transport is a stream that has already sent a 200 by the time most
 * of these can happen. A problem document cannot be retrofitted onto a response
 * whose headers are gone, so the error contract for this route is in-band.
 */
export async function* runAgent(
  user: SessionUser,
  messages: AgentMessage[],
): AsyncGenerator<AgentEvent> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('[agent] GEMINI_API_KEY is not set; lib/agent/run.ts cannot call Gemini.');
    yield { type: 'error', detail: '지금은 대답할 수 없어요. 잠시 후 다시 시도해 주세요.' };
    yield { type: 'done' };
    return;
  }

  const ai = new GoogleGenAI({ apiKey });
  const tools = forUser(user.id, user.home_area);

  const contents: Content[] = messages.slice(-MAX_HISTORY).map((m) => ({
    role: m.role,
    parts: [{ text: m.text }],
  }));

  // DOHERTY: the first byte has to leave within ~400ms of the send, and the
  // first model call takes seconds. Without this the sheet sat blank from the
  // tap until the whole answer landed at once, which reads as broken rather
  // than as working. It is closed by the `status … done` below, or by the first
  // tool's own status replacing it.
  yield { type: 'status', label: '생각하고 있어요' };

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      // STREAMED, not awaited whole. `generateContent` returns the finished
      // answer, so even after the thinking indicator the text still arrived as
      // one block — a paragraph appearing at once reads as a canned response,
      // where the same paragraph arriving progressively reads as an answer
      // being worked out. The tool-calling contract is unchanged: chunks carry
      // `functionCalls` exactly as the single response did, so the branch below
      // just accumulates instead of reading one object.
      const stream = await ai.models.generateContentStream({
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemInstruction(user),
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          // Recommending is not field-copying — 0 makes the same three places
          // come back in the same order every time, which reads as a broken
          // feature rather than a consistent one. Low enough to stay grounded.
          temperature: 0.6,
        },
      });

      const calls: NonNullable<Awaited<ReturnType<typeof ai.models.generateContent>>['functionCalls']> = [];
      let parts: Content['parts'] = [];
      let streamed = '';
      let opened = false;

      for await (const chunk of stream) {
        for (const c of chunk.functionCalls ?? []) calls.push(c);
        const chunkParts = chunk.candidates?.[0]?.content?.parts;
        if (chunkParts?.length) parts = [...(parts ?? []), ...chunkParts];

        const delta = chunk.text;
        if (delta) {
          // The thinking indicator is retired the moment real text exists, not
          // when the turn ends — otherwise it sits under the answer it was
          // standing in for.
          if (!opened) {
            yield { type: 'status', label: '생각하고 있어요', done: true };
            opened = true;
          }
          streamed += delta;
          yield { type: 'text', delta };
        }
      }

      // No tool call means the model is answering. It has already been streamed
      // above; all that is left is the empty case, which is what a safety filter
      // looks like from here.
      if (calls.length === 0) {
        if (!streamed.trim()) {
          if (!opened) yield { type: 'status', label: '생각하고 있어요', done: true };
          yield { type: 'error', detail: '답을 만들지 못했어요. 다시 물어봐 주세요.' };
        }
        yield { type: 'done' };
        return;
      }

      // A turn that called a tool may also have emitted prose first. The
      // thinking indicator is spent either way before the tool's own status
      // takes over.
      if (!opened) yield { type: 'status', label: '생각하고 있어요', done: true };

      // The model's own turn has to go back into the history verbatim — parts
      // and all — or the function responses below have nothing to attach to.
      // The model's own turn goes back into the history verbatim — parts and
      // all — or the function responses below have nothing to attach to. These
      // are accumulated across chunks rather than read off one response, which
      // is the only thing streaming changed here.
      contents.push({ role: 'model', parts: parts ?? [] });

      // Gemini can return several calls in one turn. Run them in order rather
      // than in parallel: two of the four hit Postgres and one hits Apify, and
      // ordered execution keeps the status line honest about what is happening
      // right now.
      const responseParts = [];
      for (const call of calls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;

        let outcome;
        try {
          outcome = await tools.run(name, args);
        } catch (e) {
          // A tool that threw is reported to the model as a failed tool, not as
          // a failed turn. It can apologise for the part it could not do and
          // still answer the rest — which is what §10's "degrade loudly" means
          // at this level.
          console.error(`[agent] tool ${name} threw`, e);
          responseParts.push(fnResponse(call, { error: '이 도구가 실패했습니다. 이 정보 없이 답하세요.' }));
          yield { type: 'status', label: '일부 정보를 가져오지 못했어요', done: true };
          continue;
        }

        yield { type: 'status', label: outcome.label };
        if (outcome.course) yield { type: 'course', course: outcome.course };
        // Before `sources`, because the suggestion cards carry their own links
        // and the receipts list underneath them is the summary, not the lead.
        if (outcome.suggestions?.length) {
          yield { type: 'suggestions', suggestions: outcome.suggestions };
        }
        if (outcome.sources?.length) yield { type: 'sources', sources: outcome.sources };
        yield { type: 'status', label: outcome.label, done: true };

        responseParts.push(fnResponse(call, outcome.response));
      }

      contents.push({ role: 'user', parts: responseParts });
    }

    // Fell out of the loop: MAX_STEPS model calls and still calling tools. Say
    // so rather than presenting a half-built answer as a finished one.
    yield {
      type: 'error',
      detail: '생각이 너무 길어졌어요. 조금 더 구체적으로 물어봐 주시겠어요?',
    };
    yield { type: 'done' };
  } catch (e) {
    console.error('[agent] turn failed', e);
    yield { type: 'error', detail: '대답하는 중에 문제가 생겼어요. 다시 시도해 주세요.' };
    yield { type: 'done' };
  }
}

/**
 * `id` is copied back when the SDK supplies one. Gemini omits it for single
 * calls and sets it for parallel ones, and a response that drops the id it was
 * given cannot be matched to its call.
 */
function fnResponse(call: FunctionCall, response: Record<string, unknown>) {
  return {
    functionResponse: {
      ...(call.id ? { id: call.id } : {}),
      name: call.name ?? '',
      response,
    },
  };
}
