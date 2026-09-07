import { AgentProductIcon } from "@/components/agent-product-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { selectActiveConversation, useChatStore } from "@/store/chat-store";

export function AgentPicker() {
  const agents = useChatStore((state) => state.agents);
  const conversation = useChatStore(selectActiveConversation);
  const selectAgent = useChatStore((state) => state.selectAgent);
  const locked = conversation.contextLocked || conversation.isRunning;

  return (
    <Select
      disabled={locked}
      onValueChange={(agentId) => {
        if (agentId !== conversation.agentId) {
          selectAgent(agentId);
        }
      }}
      value={conversation.agentId}
    >
      <SelectTrigger
        aria-label="Agent for this conversation"
        className="h-11 w-11 min-w-0 shrink-0 justify-center gap-0 rounded-full border-0 bg-black/[0.035] px-0 text-xs font-medium text-muted-foreground shadow-none hover:bg-black/[0.06] hover:text-foreground disabled:cursor-default disabled:opacity-100 disabled:[&>svg:last-child]:hidden [&>svg:last-child]:hidden md:h-9 md:w-9 lg:w-auto lg:max-w-[180px] lg:justify-between lg:gap-2 lg:px-2.5 lg:[&>svg:last-child]:block"
        title={
          locked
            ? "Start a new chat to choose another agent"
            : "Choose a local agent"
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <AgentProductIcon
            agentId={conversation.agentId}
            agentLabel={conversation.agentLabel}
          />
          <SelectValue>
            <span className="sr-only lg:not-sr-only lg:truncate">
              {conversation.agentLabel}
            </span>
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent className="min-w-[200px]">
        {agents.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <span className="flex items-center gap-2">
              <AgentProductIcon agentId={agent.id} agentLabel={agent.label} />
              <span>{agent.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
