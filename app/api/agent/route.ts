import { z } from 'zod';
import { withRoute } from '@/lib/route';
import { requireUser } from '@/lib/session';
import { runAgent } from '@/lib/agent/run';
import type { AgentEvent } from '@/lib/agent/types';

/**
 * POST /api/agent — one turn of the assistant, streamed as NDJSON.
 *
 * This route deliberately does NOT return a problem document once it is
 * streaming. `withRoute` still wraps it, and everything that can fail *before*
 * the first byte — no session, a malformed body — leaves as a normal RFC 9457
 * problem, which is what the client's `apiFetch` understands. After that the
 * status line is spent: a model or tool failure arrives as an in-band
 * `{ type: 'error' }` event instead. `lib/agent/run.ts` is written to never
 * throw past that point for exactly this reason.
 *
 * Not `export const runtime = 'edge'`. Streaming works on the default Node
 * runtime with no configuration, and `lib/db` needs `pg` — a TCP socket the
 * edge runtime has no way to open.
 *
 * `maxDuration` is 180s, raised from 120 when `discover_places` joined the tool
 * set. The arithmetic: that tool runs TWO Apify actors concurrently plus up to
 * fourteen extractions — the sibling route that does nothing else
 * (`app/api/saved-places/[saved_place_id]/nearby/route.ts`) budgets a full 120s
 * for exactly that work — and this route still owes a model call afterwards to
 * write the answer, on top of whatever the turn already spent getting there. At
 * 120 the worst realistic turn is killed mid-search, and a killed function does
 * not get to apologise: the sheet's spinner simply stops.
 *
 * Raising the ceiling is only half of it, because a budget nothing checks is a
 * budget nothing keeps. `lib/agent/tools.ts` refuses to START a discovery more
 * than 45s into a turn, which is what makes 180 an upper bound rather than a
 * hope. Still well inside the 300s platform ceiling.
 */
export const maxDuration = 180;

const Body = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        // Capped to keep a pasted essay from becoming the whole context window.
        // Generous enough for a real question about a day out.
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    // The client resends history each turn, so this is the ceiling on the
    // conversation the server will consider, not on what the sheet may display.
    .max(40),
});

export const POST = withRoute(async (req: Request) => {
  const user = await requireUser();
  const { messages } = Body.parse(await req.json());

  // The last message has to be the user's. A history ending in a model turn
  // would ask Gemini to continue its own sentence.
  const last = messages[messages.length - 1];
  if (last.role !== 'user') {
    return new Response(
      line({ type: 'error', detail: '메시지를 읽지 못했어요.' }) + line({ type: 'done' }),
      { status: 200, headers: STREAM_HEADERS },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runAgent(user, messages)) {
          controller.enqueue(encoder.encode(line(event)));
        }
      } catch (e) {
        // Belt and braces. `runAgent` is a generator that catches its own
        // failures; if one ever escapes, the connection must still close with a
        // terminator rather than hanging until the client times out.
        console.error('[api/agent] stream failed', e);
        controller.enqueue(
          encoder.encode(
            line({ type: 'error', detail: '대답하는 중에 문제가 생겼어요.' }) + line({ type: 'done' }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
});

const STREAM_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
  'cache-control': 'no-store',
  // Proxies that buffer a response defeat the entire point of streaming it; the
  // header is nginx's and is ignored elsewhere, which costs nothing.
  'x-accel-buffering': 'no',
};

/** One event, one line. The newline is the framing — never emit an event without it. */
function line(event: AgentEvent): string {
  return JSON.stringify(event) + '\n';
}
