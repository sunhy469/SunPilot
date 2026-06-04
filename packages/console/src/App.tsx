import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, CircleDot, FileText, Play, RefreshCw, ShieldAlert, Square, X } from "lucide-react";

type Run = { id: string; title: string; status: string; workflowId?: string; createdAt: string };
type Approval = { id: string; runId: string; title: string; reason: string; risk: string; status: string };
type Skill = { id: string; name: string; version: string; enabled: boolean; manifest: { capabilities: Array<{ name: string; title: string; risk: string }> } };
type Workflow = { id: string; title: string; version: string; enabled: boolean };
type Artifact = { id: string; runId?: string; name: string; type: string };
type Event = { id: string; type: string; payload: unknown; createdAt: string };
type Memory = { id: string; key: string; value: unknown; createdAt: string };
type Job = { id: string; runId: string; status: string; attempts: number; timeoutAt?: string; updatedAt: string };
type Config = {
  server: { host: string; port: number };
  security: { requireLocalToken: boolean; allowLan: boolean };
  storage: { home: string };
};
type RunDetail = Run & { steps: Array<{ id: string; name: string; status: string; type: string }>; events: Event[]; artifacts: Artifact[]; memory: Memory[] };

const statusLabels: Record<string, string> = {
  pending: "待处理",
  planning: "规划中",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  canceled: "已取消",
  interrupted: "已中断",
  skipped: "已跳过",
  approved: "已批准",
  rejected: "已拒绝",
  enabled: "已启用",
  disabled: "已停用"
};

function labelStatus(status: string): string {
  return statusLabels[status] ?? status;
}

export function getConsoleToken(): string {
  const token = new URLSearchParams(location.search).get("token") ?? localStorage.getItem("sunpilot.token") ?? "";
  if (token) {
    localStorage.setItem("sunpilot.token", token);
    if (new URLSearchParams(location.search).has("token")) {
      history.replaceState(null, "", location.pathname + location.hash);
    }
  }
  return token;
}

export function createApi(token: string) {
  return async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<T>;
  };
}

export function createRunEventSocket(token: string, onEvent: () => void): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/v1/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: "console_subscribe", method: "run.subscribe", params: {} }));
  });
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data)) as { method?: string };
    if (payload.method === "run.event") onEvent();
  });
  return socket;
}

export function App({ token = getConsoleToken() }: { token?: string }) {
  const [authToken, setAuthToken] = useState(token);
  const [tokenInput, setTokenInput] = useState(token);
  const api = useMemo<ReturnType<typeof createApi>>(() => createApi(authToken), [authToken]);
  const [ready, setReady] = useState<Record<string, unknown>>({});
  const [runs, setRuns] = useState<Run[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState("fixture.echo");
  const [selectedRun, setSelectedRun] = useState<string>("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState("");
  const selectedRunRef = useRef(selectedRun);
  const selectedWorkflowRef = useRef(selectedWorkflow);

  const pending = useMemo(() => approvals.filter((approval) => approval.status === "pending"), [approvals]);
  const selectedRunIsTerminal = detail ? ["completed", "failed", "canceled", "interrupted"].includes(detail.status) : true;

  const selectRun = useCallback((runId: string) => {
    selectedRunRef.current = runId;
    setSelectedRun(runId);
  }, []);

  const selectWorkflow = useCallback((workflowId: string) => {
    selectedWorkflowRef.current = workflowId;
    setSelectedWorkflow(workflowId);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError("");
      const [readyz, runList, approvalList, skillList, workflowList, artifactList, jobList, configValue] = await Promise.all([
        api<Record<string, unknown>>("/readyz"),
        api<Run[]>("/v1/runs"),
        api<Approval[]>("/v1/approvals"),
        api<Skill[]>("/v1/skills"),
        api<Workflow[]>("/v1/workflows"),
        api<Artifact[]>("/v1/artifacts"),
        api<Job[]>("/v1/jobs"),
        api<Config>("/v1/config")
      ]);
      setReady(readyz);
      setRuns(runList);
      setApprovals(approvalList);
      setSkills(skillList);
      setWorkflows(workflowList);
      setArtifacts(artifactList);
      setJobs(jobList);
      setConfig(configValue);
      if (!workflowList.some((workflow) => workflow.id === selectedWorkflowRef.current)) {
        selectWorkflow(workflowList[0]?.id ?? "fixture.echo");
      }
      const currentRun = selectedRunRef.current;
      const nextRun = runList.some((run) => run.id === currentRun) ? currentRun : runList[0]?.id || "";
      selectRun(nextRun);
      if (nextRun) setDetail(await api<RunDetail>(`/v1/runs/${nextRun}`));
      else setDetail(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [api, selectRun, selectWorkflow]);

  async function createRun() {
    await api<Run>("/v1/runs", {
      method: "POST",
      body: JSON.stringify({ input: { text: "run fixture echo workflow" }, workflowId: selectedWorkflow })
    });
    await refresh();
  }

  async function decide(id: string, approve: boolean) {
    await api(`/v1/approvals/${id}/${approve ? "approve" : "reject"}`, {
      method: "POST",
      body: JSON.stringify({ reason: approve ? "从控制台批准。" : "从控制台拒绝。" })
    });
    await refresh();
  }

  async function controlRun(action: "interrupt" | "cancel" | "retry") {
    if (!detail) return;
    await api(`/v1/runs/${detail.id}/${action}`, { method: "POST" });
    await refresh();
  }

  async function downloadArtifact(artifact: Artifact) {
    try {
      setError("");
      const response = await fetch(`/v1/artifacts/${artifact.id}/content`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {}
      });
      if (!response.ok) throw new Error(await response.text());
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.name;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!authToken) return;
    void refresh();
    if (typeof WebSocket === "undefined") return;
    const socket = createRunEventSocket(authToken, () => void refresh());
    return () => socket.close();
  }, [refresh, authToken]);

  function saveToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = tokenInput.trim();
    if (!nextToken) return;
    localStorage.setItem("sunpilot.token", nextToken);
    setAuthToken(nextToken);
  }

  return (
    <main>
      <header>
        <div>
          <h1>SunPilot</h1>
          <p>本地业务 Agent 运行时</p>
        </div>
        <div className="toolbar">
          <select value={selectedWorkflow} onChange={(event) => selectWorkflow(event.target.value)} title="工作流">
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>{workflow.title}</option>
            ))}
          </select>
          <button onClick={refresh} title="刷新"><RefreshCw size={17} /></button>
          <button onClick={createRun} title="创建运行"><Play size={17} /></button>
        </div>
      </header>

      {!authToken && (
        <form className="auth-panel" onSubmit={saveToken}>
          <label htmlFor="sunpilot-token">本地访问令牌</label>
          <div>
            <input
              id="sunpilot-token"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="sun_..."
              autoComplete="off"
            />
            <button type="submit">连接</button>
          </div>
        </form>
      )}

      {error && <div className="error">{error}</div>}

      <section className="status">
        <div><CircleDot size={16} /> 守护进程 {ready.ok ? "在线" : "离线"}</div>
        <div><Square size={16} /> 工作流 {String(ready.workflows ?? 0)}</div>
        <div><ShieldAlert size={16} /> 待审批 {pending.length}</div>
        <div><FileText size={16} /> 任务 {jobs.length}</div>
      </section>

      <div className="layout">
        <section>
          <h2>最近运行</h2>
          <div className="list">
            {runs.map((run) => (
              <button className={run.id === selectedRun ? "row active" : "row"} key={run.id} onClick={async () => { selectRun(run.id); setDetail(await api<RunDetail>(`/v1/runs/${run.id}`)); }}>
                <span>{run.title}</span>
                <b>{labelStatus(run.status)}</b>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>待审批</h2>
          <div className="list">
            {pending.map((approval) => (
              <div className="approval" key={approval.id}>
                <strong>{approval.title}</strong>
                <p>{approval.reason}</p>
                <div className="actions">
                  <button onClick={() => decide(approval.id, true)} title="批准"><Check size={16} /></button>
                  <button onClick={() => decide(approval.id, false)} title="拒绝"><X size={16} /></button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="wide">
          <h2>运行详情</h2>
          {detail && (
            <>
              <div className="run-actions">
                <button onClick={() => controlRun("interrupt")} disabled={selectedRunIsTerminal} title="中断运行">中断</button>
                <button onClick={() => controlRun("cancel")} disabled={selectedRunIsTerminal} title="取消运行">取消</button>
                <button onClick={() => controlRun("retry")} title="重试运行">重试</button>
              </div>
              <div className="timeline">
                {detail.steps.map((step) => <div key={step.id}><b>{labelStatus(step.status)}</b><span>{step.name}</span></div>)}
              </div>
              <h3>事件</h3>
              <pre>{detail.events.map((event) => `${event.createdAt}  ${event.type}`).join("\n")}</pre>
              <h3>产物</h3>
              <div className="chips">{detail.artifacts.map((artifact) => <button key={artifact.id} onClick={() => downloadArtifact(artifact)}>{artifact.name}</button>)}</div>
              <h3>记忆</h3>
              <div className="memory-list">
                {detail.memory.map((memory) => (
                  <div className="memory" key={memory.id}>
                    <strong>{memory.key}</strong>
                    <code>{JSON.stringify(memory.value)}</code>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>

        <section>
          <h2>工作流</h2>
          <div className="list">
            {workflows.map((workflow) => (
              <button className={workflow.id === selectedWorkflow ? "row active" : "row"} key={workflow.id} onClick={() => selectWorkflow(workflow.id)}>
                <span>{workflow.title}</span>
                <b>{workflow.enabled ? "已启用" : "已停用"}</b>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>技能</h2>
          <div className="list">
            {skills.map((skill) => (
              <div className="skill" key={skill.id}>
                <strong>{skill.name}</strong>
                <span>{skill.id} · {skill.version}</span>
                <small>{skill.manifest.capabilities.map((capability) => `${capability.name} (${capability.risk})`).join(", ")}</small>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2>产物</h2>
          <div className="list">
            {artifacts.map((artifact) => (
              <button className="artifact-row" key={artifact.id} onClick={() => downloadArtifact(artifact)}>
                <strong>{artifact.name}</strong>
                <span>{artifact.type}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2>任务 / 恢复</h2>
          <div className="list">
            {jobs.map((job) => (
              <div className="job" key={job.id}>
                <strong>{labelStatus(job.status)}</strong>
                <span>{job.runId}</span>
                <small>尝试 {job.attempts} 次{job.timeoutAt ? ` · 超时 ${job.timeoutAt}` : ""}</small>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2>本地配置</h2>
          {config && (
            <div className="config-card">
              <strong>{config.server.host}:{config.server.port}</strong>
              <span>令牌 {config.security.requireLocalToken ? "开启" : "关闭"} · 局域网 {config.security.allowLan ? "允许" : "关闭"}</span>
              <small>{config.storage.home}</small>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
