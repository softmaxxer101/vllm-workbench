"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import type {
  ChatMetricMessage,
  ComparePaneState,
  Conversation,
  GenerationMetrics,
  PromptHistoryItem,
  SamplingParams,
} from "./types";

export const DEFAULT_PARAMS: SamplingParams = {
  temperature: 0.7,
  top_p: 0.95,
  top_k: -1,
  max_tokens: 1024,
  repetition_penalty: 1.0,
  presence_penalty: 0.0,
  frequency_penalty: 0.0,
};

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful, precise assistant. Answer clearly and use Markdown when it improves readability.";

function uid(prefix = "id"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

function newConversation(params: SamplingParams = DEFAULT_PARAMS): Conversation {
  const now = new Date().toISOString();
  return {
    id: uid("chat"),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    params: { ...params },
    messages: [],
  };
}

interface CompareState {
  prompt: string;
  systemPrompt: string;
  left: ComparePaneState;
  right: ComparePaneState;
}

function defaultPane(temperature: number): ComparePaneState {
  return {
    params: { ...DEFAULT_PARAMS, temperature },
    output: "",
    metrics: null,
    error: null,
    hint: null,
    status: "idle",
  };
}

interface ChatStore {
  hydrated: boolean;
  conversations: Conversation[];
  activeId: string | null;
  promptHistory: PromptHistoryItem[];
  compare: CompareState;

  setHydrated: (value: boolean) => void;
  createConversation: () => string;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  setSystemPrompt: (conversationId: string, prompt: string) => void;
  setParams: (conversationId: string, patch: Partial<SamplingParams>) => void;
  addMessage: (conversationId: string, message: ChatMetricMessage) => void;
  updateMessage: (
    conversationId: string,
    messageId: string,
    patch: Partial<ChatMetricMessage>,
  ) => void;
  appendContent: (conversationId: string, messageId: string, text: string) => void;
  removeMessagesFrom: (conversationId: string, messageId: string) => void;
  clearConversation: (conversationId: string) => void;
  addPromptHistory: (prompt: string) => void;
  clearPromptHistory: () => void;
  removePromptHistory: (id: string) => void;

  setComparePrompt: (prompt: string) => void;
  setCompareSystemPrompt: (prompt: string) => void;
  patchComparePane: (side: "left" | "right", patch: Partial<ComparePaneState>) => void;
  patchCompareParams: (side: "left" | "right", patch: Partial<SamplingParams>) => void;
  resetCompare: () => void;
  importCompareMessage: (message: string) => void;
}

const emptyCompare: CompareState = {
  prompt: "",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  left: defaultPane(0.2),
  right: defaultPane(0.9),
};

export const useChatStore = create<ChatStore>()(
  persist(
    (set, get) => ({
      hydrated: false,
      conversations: [],
      activeId: null,
      promptHistory: [],
      compare: emptyCompare,

      setHydrated: (value) => set({ hydrated: value }),

      createConversation: () => {
        const active = get().conversations.find((item) => item.id === get().activeId);
        const conversation = newConversation(active?.params ?? DEFAULT_PARAMS);
        set((state) => ({
          conversations: [conversation, ...state.conversations].slice(0, 50),
          activeId: conversation.id,
        }));
        return conversation.id;
      },

      selectConversation: (id) => set({ activeId: id }),

      deleteConversation: (id) =>
        set((state) => {
          const remaining = state.conversations.filter((item) => item.id !== id);
          if (remaining.length === 0) {
            const conversation = newConversation();
            return { conversations: [conversation], activeId: conversation.id };
          }
          return {
            conversations: remaining,
            activeId: state.activeId === id ? remaining[0].id : state.activeId,
          };
        }),

      renameConversation: (id, title) =>
        set((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === id
              ? { ...item, title: title.trim() || "Untitled chat", updatedAt: new Date().toISOString() }
              : item,
          ),
        })),

      setSystemPrompt: (conversationId, prompt) =>
        set((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === conversationId ? { ...item, systemPrompt: prompt } : item,
          ),
        })),

      setParams: (conversationId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((item) =>
            item.id === conversationId
              ? { ...item, params: { ...item.params, ...patch } }
              : item,
          ),
        })),

      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            const isFirstUser =
              message.role === "user" &&
              !conversation.messages.some((item) => item.role === "user");
            return {
              ...conversation,
              title: isFirstUser
                ? message.content.trim().slice(0, 52) || "New chat"
                : conversation.title,
              messages: [...conversation.messages, message],
              updatedAt: new Date().toISOString(),
            };
          }),
        })),

      updateMessage: (conversationId, messageId, patch) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.id === messageId ? { ...message, ...patch } : message,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : conversation,
          ),
        })),

      appendContent: (conversationId, messageId, text) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((message) =>
                    message.id === messageId
                      ? { ...message, content: message.content + text }
                      : message,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : conversation,
          ),
        })),

      removeMessagesFrom: (conversationId, messageId) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            const index = conversation.messages.findIndex((item) => item.id === messageId);
            return index === -1
              ? conversation
              : { ...conversation, messages: conversation.messages.slice(0, index) };
          }),
        })),

      clearConversation: (conversationId) =>
        set((state) => ({
          conversations: state.conversations.map((conversation) =>
            conversation.id === conversationId
              ? {
                  ...conversation,
                  messages: [],
                  title: "New chat",
                  updatedAt: new Date().toISOString(),
                }
              : conversation,
          ),
        })),

      addPromptHistory: (prompt) =>
        set((state) => {
          const trimmed = prompt.trim();
          if (!trimmed) return state;
          const entries = state.promptHistory.filter((item) => item.prompt !== trimmed);
          return {
            promptHistory: [
              { id: uid("prompt"), prompt: trimmed, createdAt: new Date().toISOString() },
              ...entries,
            ].slice(0, 40),
          };
        }),

      clearPromptHistory: () => set({ promptHistory: [] }),

      removePromptHistory: (id) =>
        set((state) => ({
          promptHistory: state.promptHistory.filter((item) => item.id !== id),
        })),

      setComparePrompt: (prompt) =>
        set((state) => ({ compare: { ...state.compare, prompt } })),

      setCompareSystemPrompt: (prompt) =>
        set((state) => ({ compare: { ...state.compare, systemPrompt: prompt } })),

      patchComparePane: (side, patch) =>
        set((state) => ({
          compare: {
            ...state.compare,
            [side]: { ...state.compare[side], ...patch },
          },
        })),

      patchCompareParams: (side, patch) =>
        set((state) => ({
          compare: {
            ...state.compare,
            [side]: {
              ...state.compare[side],
              params: { ...state.compare[side].params, ...patch },
            },
          },
        })),

      resetCompare: () =>
        set((state) => ({
          compare: {
            prompt: "",
            systemPrompt: state.compare.systemPrompt,
            left: defaultPane(0.2),
            right: defaultPane(0.9),
          },
        })),

      importCompareMessage: (message) =>
        set((state) => ({
          compare: { ...state.compare, prompt: message },
        })),
    }),
    {
      name: "vllm-workbench-ui-v1",
      version: 1,
      skipHydration: true,
      partialize: (state) => ({
        conversations: state.conversations,
        activeId: state.activeId,
        promptHistory: state.promptHistory,
        compare: state.compare,
      }),
      onRehydrateStorage: () => (state, error) => {
        if (state) {
          state.setHydrated(true);
        } else if (error) {
          // Corrupt storage must not leave the UI stuck on the loading skeleton.
          useChatStore.setState({ hydrated: true });
        }
      },
    },
  ),
);

export function useActiveConversation(): Conversation | null {
  return useChatStore(
    (state) =>
      state.conversations.find((conversation) => conversation.id === state.activeId) ?? null,
  );
}

export type { Conversation, GenerationMetrics };
