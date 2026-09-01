import { useCallback, useEffect, useRef, useState } from 'react';
import {
  archiveConversation,
  cancelPendingAction,
  confirmPendingAction,
  createConversation,
  getAgentExecution,
  getConversation,
  listConversations,
  listConversationTurns,
  replayAgentExecution,
  sendConversationMessage,
  type AgentConverseResponse,
  type AgentTurnDto,
  type ConfirmPendingActionResponse,
  type ConversationDetailDto,
  type ConversationListResponse,
  type ConversationResponse,
  type ConversationSummaryDto,
  type ConversationTurnsResponse,
  type PendingActionResponse,
  type SendConversationMessageRequest,
} from '../../api/conversations';

export type AgentPageState =
  | 'initializing'
  | 'empty'
  | 'loading-conversation'
  | 'ready'
  | 'sending'
  | 'waiting-confirmation'
  | 'recoverable-error'
  | 'archived-readonly';

export interface AgentConversationApi {
  listConversations(teacherId: string): Promise<ConversationListResponse>;
  getConversation(teacherId: string, conversationId: string): Promise<ConversationResponse>;
  getAgentExecution(
    teacherId: string,
    executionId: string,
  ): Promise<{ execution: { status: 'running' | 'succeeded' | 'failed' | 'partial' | 'waiting_confirmation' } }>;
  listConversationTurns(teacherId: string, conversationId: string): Promise<ConversationTurnsResponse>;
  createConversation(teacherId: string): Promise<ConversationResponse>;
  archiveConversation(teacherId: string, conversationId: string): Promise<ConversationResponse>;
  sendConversationMessage(
    teacherId: string,
    body: SendConversationMessageRequest,
  ): Promise<AgentConverseResponse>;
  replayAgentExecution(
    teacherId: string,
    executionId: string,
    clientRequestId: string,
  ): Promise<AgentConverseResponse>;
  confirmPendingAction(
    teacherId: string,
    actionId: string,
    actionToken: string,
  ): Promise<ConfirmPendingActionResponse>;
  cancelPendingAction(teacherId: string, actionId: string): Promise<PendingActionResponse>;
}

const defaultApi: AgentConversationApi = {
  listConversations,
  getConversation,
  getAgentExecution,
  listConversationTurns,
  createConversation,
  archiveConversation,
  sendConversationMessage,
  replayAgentExecution,
  confirmPendingAction,
  cancelPendingAction,
};

export interface UseAgentConversationResult {
  pageState: AgentPageState;
  conversations: ConversationSummaryDto[];
  activeConversation: ConversationDetailDto | null;
  turns: AgentTurnDto[];
  draft: string;
  error: string | null;
  confirmationBusyActionId: string | null;
  confirmationOperation: 'confirm' | 'cancel' | null;
  confirmationErrors: Record<string, string>;
  setDraft(value: string): void;
  createNewConversation(): Promise<void>;
  selectConversation(conversationId: string): Promise<void>;
  archiveCurrentConversation(): Promise<void>;
  sendMessage(): Promise<void>;
  retryExecution(executionId: string): Promise<void>;
  confirmAction(actionId: string, actionToken: string): Promise<void>;
  cancelAction(actionId: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settledPageState(
  conversation: ConversationDetailDto,
  turns: AgentTurnDto[],
): AgentPageState {
  if (conversation.status === 'archived') return 'archived-readonly';
  const waiting = turns.some((turn) => (
    turn.kind === 'confirmation' && (turn.status === 'pending' || turn.status === 'running')
  ));
  return waiting ? 'waiting-confirmation' : 'ready';
}

export function useAgentConversation(
  teacherId: string,
  api: AgentConversationApi = defaultApi,
): UseAgentConversationResult {
  const [pageState, setPageState] = useState<AgentPageState>('initializing');
  const [conversations, setConversations] = useState<ConversationSummaryDto[]>([]);
  const [activeConversation, setActiveConversation] = useState<ConversationDetailDto | null>(null);
  const [turns, setTurns] = useState<AgentTurnDto[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmationBusyActionId, setConfirmationBusyActionId] = useState<string | null>(null);
  const [confirmationOperation, setConfirmationOperation] = useState<'confirm' | 'cancel' | null>(null);
  const [confirmationErrors, setConfirmationErrors] = useState<Record<string, string>>({});
  const confirmationLock = useRef<string | null>(null);
  const pendingSend = useRef<{
    conversationId: string;
    message: string;
    clientRequestId: string;
  } | null>(null);

  const clearConfirmationState = useCallback(() => {
    confirmationLock.current = null;
    setConfirmationBusyActionId(null);
    setConfirmationOperation(null);
    setConfirmationErrors({});
  }, []);

  const selectConversation = useCallback(async (conversationId: string) => {
    setPageState('loading-conversation');
    setError(null);
    clearConfirmationState();
    try {
      const [detailResponse, turnsResponse] = await Promise.all([
        api.getConversation(teacherId, conversationId),
        api.listConversationTurns(teacherId, conversationId),
      ]);
      setActiveConversation(detailResponse.conversation);
      setTurns(turnsResponse.items);
      setPageState(settledPageState(detailResponse.conversation, turnsResponse.items));
    } catch (caught) {
      setError(errorMessage(caught));
      setPageState('recoverable-error');
    }
  }, [api, clearConfirmationState, teacherId]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      setPageState('initializing');
      setError(null);
      try {
        const response = await api.listConversations(teacherId);
        if (!active) return;
        setConversations(response.items);
        if (response.items.length === 0) {
          setPageState('empty');
          return;
        }
        await selectConversation(response.items[0].id);
      } catch (caught) {
        if (!active) return;
        setError(errorMessage(caught));
        setPageState('recoverable-error');
      }
    }
    void initialize();
    return () => { active = false; };
  }, [api, selectConversation, teacherId]);

  const createNewConversation = useCallback(async () => {
    setPageState('loading-conversation');
    setError(null);
    try {
      const response = await api.createConversation(teacherId);
      setActiveConversation(response.conversation);
      setTurns([]);
      setConversations((current) => [
        response.conversation,
        ...current.filter((item) => item.id !== response.conversation.id),
      ]);
      setDraft('');
      clearConfirmationState();
      setPageState('ready');
    } catch (caught) {
      setError(errorMessage(caught));
      setPageState('recoverable-error');
    }
  }, [api, clearConfirmationState, teacherId]);

  const archiveCurrentConversation = useCallback(async () => {
    if (!activeConversation || activeConversation.status === 'archived') return;
    setPageState('loading-conversation');
    setError(null);
    try {
      const response = await api.archiveConversation(teacherId, activeConversation.id);
      setActiveConversation(response.conversation);
      setConversations((current) => current.filter((item) => item.id !== response.conversation.id));
      clearConfirmationState();
      setPageState('archived-readonly');
    } catch (caught) {
      setError(errorMessage(caught));
      setPageState('recoverable-error');
    }
  }, [activeConversation, api, clearConfirmationState, teacherId]);

  const sendMessage = useCallback(async () => {
    const message = draft.trim();
    if (!activeConversation || activeConversation.status === 'archived' || !message) return;
    setPageState('sending');
    setError(null);
    try {
      const request = pendingSend.current
        && pendingSend.current.conversationId === activeConversation.id
        && pendingSend.current.message === message
        ? pendingSend.current
        : {
          conversationId: activeConversation.id,
          message,
          clientRequestId: crypto.randomUUID(),
        };
      pendingSend.current = request;
      const sent = await api.sendConversationMessage(teacherId, request);
      if (sent.status === 'running') {
        let stillRunning = true;
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const current = await api.getAgentExecution(teacherId, sent.executionId);
          if (current.execution.status !== 'running') {
            stillRunning = false;
            break;
          }
        }
        if (stillRunning) throw new Error('Agent 仍在后台处理，请稍后重试或刷新会话');
      }
      const response = await api.listConversationTurns(teacherId, activeConversation.id);
      setTurns(response.items);
      setDraft('');
      pendingSend.current = null;
      setPageState(settledPageState(activeConversation, response.items));
    } catch (caught) {
      setError(errorMessage(caught));
      setPageState('recoverable-error');
    }
  }, [activeConversation, api, draft, teacherId]);

  const retryExecution = useCallback(async (executionId: string) => {
    if (!activeConversation || activeConversation.status === 'archived' || pageState === 'sending') return;
    setPageState('sending');
    setError(null);
    try {
      await api.replayAgentExecution(teacherId, executionId, crypto.randomUUID());
      const response = await api.listConversationTurns(teacherId, activeConversation.id);
      setTurns(response.items);
      setPageState(settledPageState(activeConversation, response.items));
    } catch (caught) {
      setError(errorMessage(caught));
      setPageState('recoverable-error');
    }
  }, [activeConversation, api, pageState, teacherId]);

  const runConfirmation = useCallback(async (
    actionId: string,
    operation: 'confirm' | 'cancel',
    actionToken?: string,
  ) => {
    if (
      !activeConversation
      || activeConversation.status === 'archived'
      || confirmationLock.current !== null
    ) return;
    const turn = turns.find((item) => item.kind === 'confirmation' && item.actionId === actionId);
    if (!turn || turn.kind !== 'confirmation' || turn.status !== 'pending') return;
    if (operation === 'confirm' && (!actionToken || actionToken !== turn.actionToken)) return;

    confirmationLock.current = actionId;
    setConfirmationBusyActionId(actionId);
    setConfirmationOperation(operation);
    setConfirmationErrors((current) => {
      const next = { ...current };
      delete next[actionId];
      return next;
    });
    try {
      if (operation === 'confirm') {
        await api.confirmPendingAction(teacherId, actionId, actionToken as string);
      } else {
        await api.cancelPendingAction(teacherId, actionId);
      }
      const response = await api.listConversationTurns(teacherId, activeConversation.id);
      setTurns(response.items);
      setPageState(settledPageState(activeConversation, response.items));
    } catch (caught) {
      setConfirmationErrors((current) => ({ ...current, [actionId]: errorMessage(caught) }));
      setPageState(settledPageState(activeConversation, turns));
    } finally {
      confirmationLock.current = null;
      setConfirmationBusyActionId(null);
      setConfirmationOperation(null);
    }
  }, [activeConversation, api, teacherId, turns]);

  const confirmAction = useCallback(async (actionId: string, actionToken: string) => {
    await runConfirmation(actionId, 'confirm', actionToken);
  }, [runConfirmation]);

  const cancelAction = useCallback(async (actionId: string) => {
    await runConfirmation(actionId, 'cancel');
  }, [runConfirmation]);

  return {
    pageState,
    conversations,
    activeConversation,
    turns,
    draft,
    error,
    confirmationBusyActionId,
    confirmationOperation,
    confirmationErrors,
    setDraft,
    createNewConversation,
    selectConversation,
    archiveCurrentConversation,
    sendMessage,
    retryExecution,
    confirmAction,
    cancelAction,
  };
}
