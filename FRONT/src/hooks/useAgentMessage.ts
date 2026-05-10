import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { streamChat, postApprove, postReject, ApiClientError } from '@/lib/api/client';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useWallet } from './useWallet';

export function useAgentMessage() {
  const queryClient = useQueryClient();
  const threshold = useSettingsStore((state) => state.autoConfirmThresholdUsd);
  const { address: userAddress } = useWallet();
  
  // Store actions
  const sessionId = useChatStore((state) => state.sessionId);
  const setSessionId = useChatStore((state) => state.setSessionId);
  const addUserMessage = useChatStore((state) => state.addUserMessage);
  const addAgentMessages = useChatStore((state) => state.addAgentMessages);
  const startStreaming = useChatStore((state) => state.startStreaming);
  const appendToken = useChatStore((state) => state.appendToken);
  const finishStreaming = useChatStore((state) => state.finishStreaming);
  const setProposalFromSSE = useChatStore((state) => state.setProposalFromSSE);
  const setStatus = useChatStore((state) => state.setStatus);
  const setProposalUiState = useChatStore((state) => state.setProposalUiState);
  const setPendingProposal = useChatStore((state) => state.setPendingProposal);
  const completeProposal = useChatStore((state) => state.completeProposal);

  // Track pending state
  const isPendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendUserMessage = useCallback(async (content: string) => {
    const blocked = useChatStore.getState().isInputBlocked();
    if (blocked || isPendingRef.current) return;

    isPendingRef.current = true;
    addUserMessage(content);
    startStreaming();

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      await streamChat(
        {
          type: 'user_message',
          content,
          session_id: sessionId || undefined,
          user_address: userAddress || undefined,
          user_threshold_usd: threshold,
        },
        {
          onSession: (newSessionId) => {
            setSessionId(newSessionId);
          },
          onToken: (tokenContent) => {
            appendToken(tokenContent);
          },
          onProposal: (proposal) => {
            setProposalFromSSE(proposal);
          },
          onDone: (data) => {
            if (!data.awaiting_approval) {
              finishStreaming();
            }
            // If awaiting_approval, the proposal handler already updated status
          },
          onError: (error) => {
            console.error('[chat] SSE error:', error);
            finishStreaming();
            setStatus('idle');
          },
        },
        abortControllerRef.current.signal
      );
    } catch (error) {
      if (error instanceof ApiClientError) {
        console.error('[chat] API error:', error.code, error.message);
      } else {
        console.error('[chat] Unknown error:', error);
      }
      finishStreaming();
      setStatus('idle');
    } finally {
      isPendingRef.current = false;
      abortControllerRef.current = null;
    }
  }, [
    sessionId,
    userAddress,
    threshold,
    addUserMessage,
    startStreaming,
    appendToken,
    finishStreaming,
    setSessionId,
    setProposalFromSSE,
    setStatus,
  ]);

  const approveProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    if (!proposal || !currentSessionId) return;

    setStatus('executing');
    setProposalUiState('awaiting_execution');

    try {
      const response = await postApprove(currentSessionId);
      
      // Process response messages
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
        
        // Check for execute info in response
        const textMessage = response.messages.find((m) => m.type === 'text' && 'execute' in m);
        if (textMessage && textMessage.type === 'text' && textMessage.execute) {
          completeProposal(textMessage.execute.status, textMessage.execute);
          await queryClient.invalidateQueries({ queryKey: ['wallet'] });
        } else {
          completeProposal('success');
        }
      } else {
        completeProposal('success');
      }
    } catch (error) {
      console.error('[chat] Approve error:', error);
      completeProposal('failed', { status: 'failed', error: 'Error al aprobar la transferencia' });
    }
  }, [addAgentMessages, completeProposal, setStatus, setProposalUiState, queryClient]);

  const rejectProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    if (!proposal || !currentSessionId) return;

    setProposalUiState('cancelled');
    setPendingProposal(null);
    setStatus('idle');

    try {
      const response = await postReject(currentSessionId);
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
      }
    } catch (error) {
      console.error('[chat] Reject error:', error);
      // Already cleared the proposal, just log the error
    }
  }, [addAgentMessages, setPendingProposal, setProposalUiState, setStatus]);

  return {
    sendUserMessage,
    approveProposal,
    rejectProposal,
    isPending: isPendingRef.current,
    error: null,
  };
}
