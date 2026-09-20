'use client';

import Link from 'next/link';
import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, NetworkError, apiFetch } from '@/lib/api/client';
import { Button, Card } from '@/components/surface';
import { parseReelUrl } from '@/lib/ingest/paste/url';

/**
 * Paste an Instagram reel link, get the places in it.
 *
 * ── THE SAME PARSER RUNS HERE AND ON THE SERVER ──────────────────────────────
 * `parseReelUrl` is pure — no fetch, no environment, no clock — so the browser
 * can answer "is this a reel link" in zero milliseconds using the exact code the
 * route will use. That is not a convenience, it is what makes the Doherty
 * Threshold reachable at all on a screen whose real work takes ten seconds: the
 * part that CAN be instant is instant, and the part that cannot is acknowledged
 * honestly instead of being faked. A second, looser client-side regex would be
 * the classic version of this bug — a link the field accepts and the server
 * rejects, with no way for the user to tell which one is wrong.
 *
 * ── PASTE-AND-GO WAS CONSIDERED AND REJECTED ────────────────────────────────
 * Firing on paste would save one tap. It would also spend a video download, a
 * model call and ten geocodes on a mis-paste, on a link copied to check
 * something, and on every stray clipboard in a share sheet — and the write is
 * not free to undo, because the reel and its places land in the user's saved
 * list. An expensive, several-second, state-changing action gets a button. What
 * paste-and-go was actually for — not making the user wait to find out the link
 * is wrong — is delivered by the local parser instead, which is the half of it
 * that costs nothing.
 *
 * ── THE BUTTON IS NOT DISABLED FOR A BAD LINK ───────────────────────────────
 * Only for an empty field and for a request already in flight. A disabled button
 * over an unparseable link is a dead end: the user has no way to ask why, and
 * Enter does nothing. Pressing it with a bad link costs no request and answers
 * immediately with the reason — which is the cheapest possible version of
 * "always tell them something".
 *
 * ── NO STATE IS REPAIRED IN AN EFFECT ───────────────────────────────────────
 * There is no `useEffect` in this file. Validity is DERIVED during render from
 * `text`, so a link that becomes valid as it is corrected clears its own error
 * with no second render pass and no write-back. `attempted` exists only so the
 * refusal is silent until the user has actually tried — nobody should be told
 * `https:` is not a reel link while they are still typing it.
 */

/** What the server said, as one value. Two booleans would be two chances to disagree. */
type Outcome =
  | { kind: 'idle' }
  | { kind: 'working' }
  /** Saved just now. `found` venues named, `saved` of them with a place to open. */
  | { kind: 'saved'; found: number; saved: number }
  /** A second paste of a link already in this account. Not an error. */
  | { kind: 'already' }
  | { kind: 'failed'; message: string };

const REFUSAL: Record<'not-instagram' | 'not-a-post', string> = {
  // The two URL-level refusals, said in the browser and never sent anywhere.
  // They are the same sentences lib/problem.ts sends for the server-side
  // backstop, because a user should not get two different explanations of one
  // mistake depending on which copy of the check caught it.
  'not-instagram': '인스타그램 주소가 아니에요. 릴스에서 공유 › 링크 복사를 눌러 나온 주소를 붙여넣어 주세요.',
  'not-a-post': '게시물 주소가 아니에요. 프로필이나 스토리 말고, 릴스를 열어서 링크 복사를 눌러 주세요.',
};

type SaveReelResponse = {
  reel_id: string;
  already_saved: boolean;
  places_found: number;
  places_saved: number;
};

export function PasteForm() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const fieldId = useId();
  const hintId = useId();

  // DERIVED DURING RENDER. Both of these are functions of `text` and nothing
  // else, so there is no way for the field and the button to hold different
  // opinions about the same string.
  const trimmed = text.trim();
  const parsed = parseReelUrl(text);
  const refusal = attempted && trimmed !== '' && !parsed.ok ? REFUSAL[parsed.reason] : null;

  const working = outcome.kind === 'working';

  async function submit() {
    if (working) return;
    setAttempted(true);
    // A bad link never leaves the browser. `refusal` above renders from the same
    // `parsed`, so returning here is the whole of the error path.
    if (!parsed.ok) return;

    setOutcome({ kind: 'working' });
    try {
      const res = await apiFetch<SaveReelResponse>('/reels', {
        method: 'POST',
        body: { url: parsed.canonicalUrl },
      });
      setOutcome(
        res.already_saved
          ? { kind: 'already' }
          : { kind: 'saved', found: res.places_found, saved: res.places_saved },
      );
      // Cleared so the next link can go straight in — people save several at a
      // time, and a field still holding the last one has to be selected and
      // overwritten first. The result card below survives the clear.
      setText('');
      setAttempted(false);
      // The home deck and the saved list were rendered before this reel existed.
      // Ask the server for them again so tapping through lands on a screen that
      // already has the new places, rather than one that fetches them on arrival.
      router.refresh();
    } catch (err) {
      // `detail` on a problem document is written to be read by the person who
      // hit it — lib/problem.ts owns every one of these sentences, including the
      // expired-session one, which is deliberately written not to blame them.
      if (err instanceof ApiError) setOutcome({ kind: 'failed', message: err.problem.detail });
      else if (err instanceof NetworkError) setOutcome({ kind: 'failed', message: err.message });
      else setOutcome({ kind: 'failed', message: '알 수 없는 오류가 생겼어요.' });
    }
  }

  return (
    <Card className="p-[var(--space-13)]">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={fieldId} className="block text-secondary" style={{ font: 'var(--type-caption)' }}>
          릴스 주소
        </label>

        <div className="mt-[var(--space-7)] flex h-[var(--field-height)] w-full items-center rounded-[var(--radius-2xl)] bg-surface-2 px-[var(--space-11)]">
          <input
            id={fieldId}
            // `url` rather than `text`: it brings the right mobile keyboard —
            // a visible `/` and `.com` — and nothing else. Validation is the
            // parser's, not the browser's; `type="url"` alone would reject a
            // pasted `instagram.com/reel/x` that this form accepts on purpose.
            type="url"
            inputMode="url"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              // A new link makes the last result stale. Clearing it here — in
              // the event, not in an effect watching `text` — is what keeps a
              // success card from hanging over a field that has moved on.
              if (outcome.kind !== 'idle' && outcome.kind !== 'working') setOutcome({ kind: 'idle' });
            }}
            readOnly={working}
            placeholder="https://www.instagram.com/reel/..."
            maxLength={2048}
            aria-invalid={refusal !== null}
            aria-describedby={hintId}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            className="h-full min-w-0 flex-1 bg-transparent outline-none"
            style={{ font: 'var(--type-body)' }}
          />
        </div>

        {/* One line under the field, always present, so the layout does not jump
            between a hint and an error. `tertiary` is not used for either — it
            measures 2.81:1 and the record forbids it on text a user must read. */}
        <p id={hintId} className="mt-[var(--space-7)] text-secondary" style={{ font: 'var(--type-caption)' }}>
          {refusal ?? '릴스에서 공유 › 링크 복사를 눌러 나온 주소를 붙여넣어 주세요.'}
        </p>

        <Button
          type="submit"
          variant="primary"
          className="mt-[var(--space-11)] w-full"
          disabled={trimmed === '' || working}
        >
          {working ? '저장 중' : '저장하기'}
        </Button>
      </form>

      {/* THE LIVE REGION, and it stays in the document while empty. A screen
          reader only announces a change inside a region that already existed, so
          a wrapper conjured up alongside its own content announces nothing —
          which is the whole point of having one. Same reasoning, same `polite`,
          as app/(app)/home/ingest-status.tsx. */}
      <div role="status" aria-live="polite">
        {outcome.kind === 'working' ? <Working /> : null}
        {outcome.kind === 'saved' ? <Saved found={outcome.found} saved={outcome.saved} /> : null}
        {outcome.kind === 'already' ? <AlreadySaved /> : null}
      </div>

      {outcome.kind === 'failed' ? (
        <p
          role="alert"
          className="mt-[var(--space-11)] rounded-[var(--radius-2xl)] bg-[var(--status-cancel-bg)] p-[var(--space-9)] text-ink"
          style={{ font: 'var(--type-meta)' }}
        >
          {outcome.message}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Ten-odd seconds of real work, acknowledged honestly.
 *
 * NO PROGRESS BAR AND NO SPINNER, for the reason ingest-status.tsx already
 * writes down: nothing on this screen knows how long the work will take. The
 * request is one round trip covering a caption fetch, possibly a 4 MB video
 * download plus a model call, and one sequential geocode per venue — a bar
 * filling at an invented rate would be a lie told smoothly. And the record's
 * motion budget has no transforms in it, so a spinner is not available even if
 * it were wanted. What is left is the truth: name both things that are actually
 * happening, and give an order of magnitude rather than a countdown.
 */
function Working() {
  return (
    <div className="mt-[var(--space-13)] flex items-start gap-[var(--space-8)]">
      <span
        aria-hidden
        className="mt-[var(--space-6)] h-1.5 w-1.5 shrink-0 rounded-full bg-ink motion-safe:animate-[fade_1.1s_var(--ease-fade)_infinite_alternate]"
      />
      <div className="min-w-0">
        <p style={{ font: 'var(--type-card-title)' }}>릴스를 읽고 있어요</p>
        <p className="mt-[var(--space-2)] text-secondary" style={{ font: 'var(--type-meta)' }}>
          장소를 찾는 중이에요. 10초쯤 걸려요.
        </p>
      </div>
    </div>
  );
}

/**
 * Where a save leads.
 *
 * `저장됐어요` and nothing else would end the flow at a full stop, which is the
 * failure this component exists to avoid: the user came here to get somewhere,
 * and the places are now two taps away with no sign of which two. Every branch
 * that produced something to look at carries the link to it.
 *
 * THE THREE OUTCOMES ARE NOT ONE OUTCOME. `found` is what the extractor named
 * and `saved` is how many of those got a place row — and the gap between them is
 * a real, common state (an address that does not geocode), not an edge case. A
 * single "N곳 저장했어요" would report ten for a reel that produced seven
 * openable places and three rows the user will find sitting unresolved.
 */
function Saved({ found, saved }: { found: number; saved: number }) {
  if (saved > 0) {
    return (
      <Result
        title={`${saved}곳을 저장했어요`}
        body={
          found > saved
            ? `릴스에서 ${found}곳을 찾았고, 그중 ${found - saved}곳은 위치를 확인하지 못했어요.`
            : '저장한 곳에 담아뒀어요.'
        }
        href="/saved-places"
        cta="저장한 곳에서 보기"
      />
    );
  }

  if (found > 0) {
    return (
      <Result
        title="장소 이름은 찾았어요"
        body={`${found}곳의 이름을 찾았지만 위치를 확인하지 못했어요. 저장한 곳에서 직접 확인해 주세요.`}
        href="/saved-places"
        cta="저장한 곳에서 보기"
      />
    );
  }

  // Nothing was extracted. The reel IS saved — `claimReel` wrote the row before
  // any analysis — and there are no places to link to, so this branch leads
  // nowhere on purpose rather than pointing at an empty list. What it does
  // instead is say what the extractor reads, which is the only thing that lets
  // the user pick a better reel next time.
  return (
    <div className="mt-[var(--space-13)]">
      <p style={{ font: 'var(--type-card-title)' }}>릴스는 저장했지만 장소를 찾지 못했어요</p>
      <p className="mt-[var(--space-2)] text-secondary" style={{ font: 'var(--type-meta)' }}>
        캡션과 영상에서 가게 이름을 찾지 못했어요. 가게 이름이 캡션에 적힌 릴스가 가장 잘 돼요.
      </p>
    </div>
  );
}

function AlreadySaved() {
  return (
    <Result
      title="이미 저장한 릴스예요"
      body="같은 릴스는 한 번만 저장돼요. 먼저 저장한 내용은 그대로 있어요."
      href="/saved-places"
      cta="저장한 곳에서 보기"
    />
  );
}

function Result({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return (
    <div className="mt-[var(--space-13)]">
      <p style={{ font: 'var(--type-card-title)' }}>{title}</p>
      <p className="mt-[var(--space-2)] text-secondary" style={{ font: 'var(--type-meta)' }}>
        {body}
      </p>
      {/* `›` is a text node, not an icon: it is part of the label's typography
          and inherits its size and colour for free — the same treatment home's
          더보기 links get. */}
      <Link
        href={href}
        className="mt-[var(--space-8)] inline-flex min-h-[var(--tap-min)] items-center text-ink"
        style={{ font: 'var(--type-meta)' }}
      >
        {cta} ›
      </Link>
    </div>
  );
}
