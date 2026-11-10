/**
 * Route-level screens that connect feature screens to the chat refinement
 * panel (Requirement 13.14). Each screen owns the panel's open state and
 * target, and refreshes the related queries when a refinement is applied.
 *
 * Voice input (Requirement 11.2) is wired here too: the fridge editor, the
 * suggestion note, and every chat composer get a VoiceButton whose confirmed
 * result refreshes that view.
 */
import { useCallback, useState } from 'react';
import { Navigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { MealSuggestion, UpdatedArtifact } from './api/types';
import { ChatPanel, type ChatTarget, type ChatVoiceSlotProps } from './features/chat';
import { weekdayOf } from './features/chat/chatModel';
import { FridgeEditor } from './features/fridge';
import { GroceryScreen } from './features/grocery';
import { PlanView, plansListKey, type RefineDayTarget } from './features/plans';
import { SuggestScreen } from './features/suggest';
import { ChatVoiceAction, ContextVoiceAction, FridgeVoiceAction } from './features/voice';
import { useActiveHousehold } from './household/ActiveHouseholdProvider';

/** Open/close state for one chat target. The target stays set while the sheet animates closed. */
function useChat() {
  const [target, setTarget] = useState<ChatTarget | null>(null);
  const [open, setOpen] = useState(false);
  const launch = useCallback((next: ChatTarget) => {
    setTarget(next);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { target, open, launch, close };
}

function chatVoice(props: ChatVoiceSlotProps) {
  return <ChatVoiceAction {...props} />;
}

export function FridgeRoute() {
  return <FridgeEditor renderVoiceAction={(slot) => <FridgeVoiceAction slot={slot} />} />;
}

export function SuggestRoute() {
  const chat = useChat();
  const [refined, setRefined] = useState<MealSuggestion>();
  return (
    <>
      <SuggestScreen
        refinedSuggestion={refined}
        renderVoiceAction={(slot) => <ContextVoiceAction slot={slot} />}
        onRefine={(suggestion, sessionId) =>
          chat.launch({ type: 'suggestion', sessionId, suggestionId: suggestion.suggestionId, title: suggestion.name })
        }
      />
      {chat.target && (
        <ChatPanel
          open={chat.open}
          onClose={chat.close}
          target={chat.target}
          onUpdated={(artifact) => {
            if (artifact.type === 'suggestion') setRefined(artifact.suggestion);
          }}
          voiceSlot={chatVoice}
        />
      )}
    </>
  );
}

export function PlanRoute() {
  const chat = useChat();
  const queryClient = useQueryClient();
  const { activeHouseholdId } = useActiveHousehold();

  function refineDay({ planId, day, meal }: RefineDayTarget) {
    chat.launch({ type: 'plan', planId, day, title: `${weekdayOf(day)}: ${meal.name}` });
  }

  // ChatPanel already refreshes the plan and its grocery list; the plans list shows plan metadata.
  function onUpdated(artifact: UpdatedArtifact) {
    if (artifact.type === 'plan') void queryClient.invalidateQueries({ queryKey: plansListKey(activeHouseholdId) });
  }

  return (
    <>
      <PlanView onRefineDay={refineDay} />
      {chat.target && <ChatPanel open={chat.open} onClose={chat.close} target={chat.target} onUpdated={onUpdated} voiceSlot={chatVoice} />}
    </>
  );
}

export function GroceryRoute() {
  const chat = useChat();
  return (
    <>
      <GroceryScreen onRefine={(planId) => chat.launch({ type: 'grocery_list', planId, title: 'Grocery list' })} />
      {/* ChatPanel writes the refined list into the grocery query cache itself. */}
      {chat.target && <ChatPanel open={chat.open} onClose={chat.close} target={chat.target} voiceSlot={chatVoice} />}
    </>
  );
}

/** `/plans/:planId/grocery` (design route table) is an alias of `/grocery/:planId`. */
export function PlanGroceryRedirect() {
  const { planId = '' } = useParams();
  return <Navigate to={`/grocery/${encodeURIComponent(planId)}`} replace />;
}
