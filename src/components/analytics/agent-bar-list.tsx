interface AgentStat {
  name: string;
  total: number;
  resolved: number;
}

export function AgentBarList({ data }: { data: AgentStat[] }) {
  const max = Math.max(1, ...data.map((d) => d.total));

  return (
    <div className="space-y-3">
      {data.map((agent) => (
        <div key={agent.name}>
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">{agent.name}</span>
            <span className="text-muted-foreground">
              {agent.resolved} טופלו מתוך {agent.total}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${(agent.total / max) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
