/**
 * VoiceButton adapters for the three free-text inputs that accept voice
 * (Requirement 11.2): the fridge editor, the suggestion note (Context_Input),
 * and the chat composer. Each one sets the matching `targetOperation` and
 * refreshes its view with the confirmed result.
 */
import type { SendMessageResponse, SuggestResponse } from '../../api/types';
import type { ChatVoiceSlotProps } from '../chat/ChatPanel';
import { CHAT_MESSAGE_MAX } from '../chat/chatModel';
import type { FridgeVoiceSlot } from '../fridge/FridgeEditor';
import type { SuggestVoiceSlot } from '../suggest/SuggestScreen';
import { CONTEXT_INPUT_MAX } from '../suggest/validation';
import { useToast } from '../../ui';
import { VoiceButton, type RecorderFactory } from './VoiceButton';

interface WithRecorder {
  createRecorder?: RecorderFactory;
}

export function FridgeVoiceAction({ slot, createRecorder }: { slot: FridgeVoiceSlot } & WithRecorder) {
  const toast = useToast();
  return (
    <VoiceButton
      label="Speak your fridge items"
      title="Tell Sous what’s in your fridge"
      description="For example: “six eggs, a litre of milk, and a bag of spinach”."
      confirmDescription="Fix anything that’s wrong. Confirming replaces your fridge list with these items."
      confirmLabel="Update fridge"
      disabled={slot.disabled}
      resolveTarget={() => slot.targetOperation}
      onConfirmed={() => {
        slot.onApplied();
        toast.show({ tone: 'success', message: 'Fridge updated from your recording.' });
      }}
      createRecorder={createRecorder}
    />
  );
}

export function ContextVoiceAction({ slot, createRecorder }: { slot: SuggestVoiceSlot } & WithRecorder) {
  return (
    <VoiceButton
      label="Speak your note"
      title="Tell Sous what you feel like"
      description="For example: “something warm that’s ready in 20 minutes”."
      confirmDescription="Fix anything that’s wrong. Confirming asks Sous for suggestions with this note."
      confirmLabel="Get suggestions"
      disabled={slot.disabled}
      maxTranscriptCodePoints={CONTEXT_INPUT_MAX}
      resolveTarget={() => slot.targetOperation}
      onConfirmed={(response) => slot.showResult(response.result as SuggestResponse, response.transcript)}
      createRecorder={createRecorder}
    />
  );
}

export function ChatVoiceAction({ ensureConversation, disabled, receiveVoiceResult, createRecorder }: ChatVoiceSlotProps & WithRecorder) {
  return (
    <VoiceButton
      label="Speak your message"
      title="Tell Sous what to change"
      description="For example: “swap the chicken for tofu”."
      confirmDescription="Fix anything that’s wrong. Confirming sends this message."
      confirmLabel="Send"
      variant="ghost"
      disabled={disabled}
      maxTranscriptCodePoints={CHAT_MESSAGE_MAX}
      resolveTarget={async () => ({ type: 'conversation', conversationId: await ensureConversation() })}
      onConfirmed={(response) => receiveVoiceResult(response.transcript, response.result as SendMessageResponse)}
      createRecorder={createRecorder}
    />
  );
}
