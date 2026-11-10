/**
 * Chat refinement panel (Requirements 9.1, 9.5, 13.14).
 *
 * A bottom sheet on phones and a right-hand side panel from `lg` (ui/Sheet).
 *
 * Conversation lifecycle: the Conversation is started lazily, on the first
 * message (or when the voice slot calls `ensureConversation()`), so opening
 * and closing the panel without typing creates nothing on the server. It is
 * reused for every later message while the panel stays open for the same
 * target (see `targetKey`). Closing the panel or switching target discards it
 * and the next message starts a new one.
 *
 * Outcomes:
 * - `clarification`: shown as an assistant message; the artifact is unchanged.
 * - `updated`: shown as a short assistant summary; the plan or grocery query
 *   cache is updated and `onUpdated(artifact)` is called. A response that
 *   arrives after the panel closed still updates the cache and calls
 *   `onUpdated`, because the server has already applied the change.
 * - error: an inline error bubble with Retry, which resends the same message.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RotateCw, SendHorizontal, Sparkles } from 'lucide-react';
import { useApi } from '../../app/ServicesProvider';
import { isApiError } from '../../api/errors';
import type { SendMessageResponse, StoredPlan, UpdatedArtifact } from '../../api/types';
import { useActiveHousehold } from '../../household/ActiveHouseholdProvider';
import { Button, IconButton, Sheet, Spinner, TextArea, cx } from '../../ui';
import { planKey } from '../plans/planQueries';
import {
  CHAT_MESSAGE_MAX,
  applyGroceryRefinement,
  applyPlanRefinement,
  canSend,
  composerPlaceholder,
  conversationRequest,
  groceryListKey,
  isMessageTooLong,
  summarizeUpdate,
  targetKey,
  type ChatTarget,
} from './chatModel';

/** What the composer's voice slot receives (task 24.5). */
export interface ChatVoiceSlotProps {
  /** Starts the Conversation if needed and resolves to its id, for `{ type: 'conversation', conversationId }`. */
  ensureConversation: () => Promise<string>;
  /** True while a message is in flight. */
  disabled: boolean;
  /** Shows a confirmed voice Transcript and its Conversation result as if it had been typed. */
  receiveVoiceResult: (transcript: string, response: SendMessageResponse) => void;
}

export interface ChatPanelProps {
  open: boolean;
  onClose: () => void;
  target: ChatTarget;
  /** Called with the updated artifact on `outcome: 'updated'`. */
  onUpdated?: (artifact: UpdatedArtifact) => void;
  /** Renders a voice button beside the composer. */
  voiceSlot?: (props: ChatVoiceSlotProps) => ReactNode;
}

const ERROR_FALLBACK = "Couldn't send that. Please try again.";

function errorText(error: unknown): string {
  return isApiError(error) ? error.userMessage : ERROR_FALLBACK;
}

export function ChatPanel({ open, onClose, target, onUpdated, voiceSlot }: ChatPanelProps) {
  const composerRef = useRef<HTMLTextAreaElement>(null);
  return (
    <Sheet open={open} onClose={onClose} title="Refine with Sous" description={target.title} initialFocusRef={composerRef} closeLabel="Close chat">
      <ChatSession key={targetKey(target)} target={target} onUpdated={onUpdated} voiceSlot={voiceSlot} composerRef={composerRef} />
    </Sheet>
  );
}

type ChatMessage =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string; kind: 'clarification' | 'updated' }
  | { id: number; role: 'error'; text: string; retryText: string };

/** A ChatMessage without its id (distributes over the union). */
type NewChatMessage = ChatMessage extends infer M ? (M extends ChatMessage ? Omit<M, 'id'> : never) : never;

interface ChatSessionProps {
  target: ChatTarget;
  onUpdated?: (artifact: UpdatedArtifact) => void;
  voiceSlot?: (props: ChatVoiceSlotProps) => ReactNode;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

function prefersTouch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

function ChatSession({ target, onUpdated, voiceSlot, composerRef }: ChatSessionProps) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const nextId = useRef(1);
  const conversation = useRef<Promise<string> | null>(null);
  const mounted = useRef(true);
  const endRef = useRef<HTMLDivElement>(null);
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, pending]);

  useEffect(() => {
    // The composer is disabled while pending, which drops focus; give it back.
    if (!pending) composerRef.current?.focus();
  }, [pending, composerRef]);

  const append = useCallback((message: NewChatMessage) => {
    if (!mounted.current) return;
    const id = nextId.current++;
    setMessages((list) => [...list, { ...message, id } as ChatMessage]);
  }, []);

  const ensureConversation = useCallback((): Promise<string> => {
    if (!conversation.current) {
      const started = api.startConversation(conversationRequest(target)).then((r) => r.conversation.conversationId);
      // A failed start is not cached, so Retry starts again.
      started.catch(() => {
        if (conversation.current === started) conversation.current = null;
      });
      conversation.current = started;
    }
    return conversation.current;
  }, [api, target]);

  const applyUpdate = useCallback(
    (artifact: UpdatedArtifact) => {
      if (artifact.type === 'plan') {
        const key = planKey(activeHouseholdId, artifact.plan.planId);
        queryClient.setQueryData<StoredPlan>(key, (old) => (old ? applyPlanRefinement(old, artifact) : old));
        void queryClient.invalidateQueries({ queryKey: key });
        void queryClient.invalidateQueries({ queryKey: groceryListKey(activeHouseholdId, artifact.plan.planId) });
      } else if (artifact.type === 'grocery_list') {
        const key = groceryListKey(activeHouseholdId, artifact.groceryList.planId);
        queryClient.setQueryData(key, (old: unknown) => applyGroceryRefinement(old, artifact) ?? old);
        void queryClient.invalidateQueries({ queryKey: key });
      }
      onUpdatedRef.current?.(artifact);
    },
    [activeHouseholdId, queryClient],
  );

  const receive = useCallback(
    (response: SendMessageResponse) => {
      if (response.outcome === 'clarification') {
        append({ role: 'assistant', kind: 'clarification', text: response.message });
      } else {
        applyUpdate(response.artifact);
        append({ role: 'assistant', kind: 'updated', text: summarizeUpdate(response.artifact) });
      }
    },
    [append, applyUpdate],
  );

  const send = useCallback(
    async (text: string, retryOf?: number) => {
      if (pending || !canSend(text)) return;
      if (retryOf === undefined) {
        append({ role: 'user', text });
        setDraft('');
      } else {
        setMessages((list) => list.filter((m) => m.id !== retryOf));
      }
      setPending(true);
      try {
        const conversationId = await ensureConversation();
        receive(await api.sendMessage(conversationId, { message: text }));
      } catch (error) {
        append({ role: 'error', text: errorText(error), retryText: text });
      } finally {
        if (mounted.current) setPending(false);
      }
    },
    [api, append, ensureConversation, pending, receive],
  );

  const receiveVoiceResult = useCallback(
    (transcript: string, response: SendMessageResponse) => {
      append({ role: 'user', text: transcript });
      receive(response);
    },
    [append, receive],
  );

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    // On touch keyboards Enter inserts a newline; the send button sends.
    if (prefersTouch()) return;
    event.preventDefault();
    void send(draft);
  }

  const tooLong = isMessageTooLong(draft);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <div role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation" className="flex flex-1 flex-col gap-3">
        {messages.length === 0 && (
          <div className="flex items-start gap-3 rounded-2xl bg-surface-2 p-4 text-sm text-text-muted">
            <Sparkles aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
            <p>Tell Sous what to change. If something is unclear, Sous asks before changing anything.</p>
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onRetry={(text) => void send(text, m.id)} retryDisabled={pending} />
        ))}
        {pending && (
          <div className="flex items-center gap-2 self-start rounded-2xl rounded-bl-md bg-surface-2 px-4 py-3 text-sm text-text-muted">
            <Spinner size="sm" label={null} />
            <span>Sous is thinking…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={onSubmit} className="sticky bottom-0 -mx-1 flex items-end gap-2 bg-surface px-1 pt-2 pb-1" aria-label="Send a message">
        <TextArea
          ref={composerRef}
          label={<span className="sr-only">Message</span>}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={composerPlaceholder(target)}
          maxCodePoints={CHAT_MESSAGE_MAX}
          error={tooLong ? `Keep your message to ${CHAT_MESSAGE_MAX} characters or fewer.` : undefined}
          disabled={pending}
          rows={2}
          className="min-h-14"
          containerClassName="min-w-0 flex-1"
          enterKeyHint="send"
        />
        <div className={cx('flex shrink-0 gap-1', tooLong ? 'mb-8' : 'mb-0.5')}>
          {voiceSlot?.({ ensureConversation, disabled: pending, receiveVoiceResult })}
          <IconButton type="submit" variant="primary" label="Send" icon={<SendHorizontal />} disabled={pending || !canSend(draft)} />
        </div>
      </form>
    </div>
  );
}

function MessageBubble({ message, onRetry, retryDisabled }: { message: ChatMessage; onRetry: (text: string) => void; retryDisabled: boolean }) {
  if (message.role === 'user') {
    return (
      <div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-contrast">
        <span className="sr-only">You: </span>
        {message.text}
      </div>
    );
  }
  if (message.role === 'error') {
    return (
      <div role="alert" className="flex max-w-[85%] flex-col gap-2 self-start rounded-2xl rounded-bl-md border border-danger/40 bg-danger-soft px-4 py-3 text-sm text-text">
        <p className="flex items-start gap-2">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>{message.text}</span>
        </p>
        <Button
          variant="secondary"
          onClick={() => onRetry(message.retryText)}
          disabled={retryDisabled}
          icon={<RotateCw aria-hidden="true" className="size-4" />}
          className="self-start"
        >
          Retry
        </Button>
      </div>
    );
  }
  return (
    <div
      data-kind={message.kind}
      className={cx(
        'max-w-[85%] self-start whitespace-pre-wrap break-words rounded-2xl rounded-bl-md px-4 py-2.5 text-sm',
        message.kind === 'updated' ? 'border border-accent/40 bg-surface text-text' : 'bg-surface-2 text-text',
      )}
    >
      <span className="sr-only">Sous: </span>
      {message.text}
    </div>
  );
}
